"""The import/export surfaces that don't belong to an existing CRUD router:

  note_pages        markdown pages, re-indexed on import exactly as on save
  effort-estimates  the Function Point driver sheet — the one that lets a real
                    company function list come in with its effort already
                    calculated, instead of typing drivers per function
  schedule          plan dates and manual actual overrides in one file, for
                    migrating a project that has no activity history

RBAC matches the modules they write to: internal-only.
"""

import json

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from .. import effort_budget, effort_calculator, models, note_parser, progress_matrix
from ..auth import get_current_user, require_internal
from ..database import get_master_db, get_project_db
from ..import_engine import ImportError_, export_response, raise_import_errors, read_rows, template_response
from ..import_schemas import EFFORT_ESTIMATES, NOTE_PAGES, SCHEDULE

router = APIRouter(prefix="/api/{slug}", tags=["import-export"], dependencies=[Depends(get_current_user)])


# ==========================================================================
# Note pages
# ==========================================================================


@router.get("/note-pages/import-template")
def note_pages_template(slug: str):
    return template_response(NOTE_PAGES, "note-pages-import-template.xlsx")


@router.get("/note-pages/export")
def export_note_pages(slug: str, db: Session = Depends(get_project_db)):
    pages = db.query(models.NotePage).order_by(models.NotePage.id).all()
    rows = [{col: getattr(p, col, None) for col in NOTE_PAGES.export_columns} for p in pages]
    return export_response(rows, NOTE_PAGES.export_columns, f"{slug}-note-pages.xlsx")


@router.post("/note-pages/import")
async def import_note_pages(
    slug: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_project_db),
    _user: models.User = Depends(require_internal),
):
    content = await file.read()
    try:
        records, report = read_rows(content, NOTE_PAGES)
    except ImportError_ as exc:
        raise_import_errors(exc)

    created = 0
    for record in records:
        page = models.NotePage(
            title=record["title"],
            content_markdown=record.get("content_markdown") or "",
            created_by=record.get("created_by"),
        )
        db.add(page)
        db.flush()
        # Same resync as saving in the app, so imported notes get their tags
        # and wiki-links indexed rather than arriving inert.
        note_parser.resync_note(db, page)
        created += 1
    db.commit()
    return {"imported": created, **report}


# ==========================================================================
# Effort estimates (Function Point driver sheet)
# ==========================================================================


def _work_type_of(record: dict) -> str | None:
    """Three 1/0 flags, matching the source spreadsheet's layout. Screen wins,
    then Report, then Batch — the same precedence the workbook's own nested
    IF() uses."""
    def flag(name):
        value = record.get(name)
        try:
            return float(value) == 1
        except (TypeError, ValueError):
            return False

    if flag("work_type_screen"):
        return "screen"
    if flag("work_type_report"):
        return "report"
    if flag("work_type_batch"):
        return "batch"
    return None


@router.get("/effort-estimates/import-template")
def effort_template(slug: str):
    return template_response(EFFORT_ESTIMATES, "effort-estimates-import-template.xlsx")


@router.get("/effort-estimates/export")
def export_effort_estimates(slug: str, db: Session = Depends(get_project_db)):
    """Round-trippable: the driver counts come back out under the same column
    names they went in under, so an exported file can be edited and re-imported."""
    functions = {f.id: f for f in db.query(models.Function).all()}
    estimates = (
        db.query(models.EffortEstimate)
        .filter(models.EffortEstimate.linked_entity_type == "function")
        .order_by(models.EffortEstimate.id)
        .all()
    )
    rows = []
    for e in estimates:
        fn = functions.get(e.linked_entity_id)
        drivers = json.loads(e.driver_counts_json) if e.driver_counts_json else {}
        row = {
            "function_code": fn.function_code if fn else None,
            "name": fn.name if fn else None,
            "phase": fn.phase if fn else None,
            "owner": fn.owner if fn else None,
            "status": fn.status if fn else None,
            "module": fn.module if fn else None,
            "priority": e.priority,
            "work_type_screen": 1 if e.work_type == "screen" else 0,
            "work_type_report": 1 if e.work_type == "report" else 0,
            "work_type_batch": 1 if e.work_type == "batch" else 0,
            "complexity": e.complexity,
            "non_similarity": e.non_similarity,
            "standard_mm": None,
            "delivery_mode": e.delivery_mode,
            "calculated_fp": e.calculated_fp,
            "calculated_final_fp": e.calculated_final_fp,
            "calculated_mm": e.calculated_mm,
            "calculated_man_days": e.calculated_man_days,
            "md_dr": e.md_dr,
            "md_dnpu": e.md_dnpu,
            "md_iftbct": e.md_iftbct,
            "not_counted_reason": None if e.priority == effort_calculator.COUNTED_PRIORITY else f"priority {e.priority}",
        }
        for key in EFFORT_ESTIMATES.importable:
            if key not in row:
                row[key] = drivers.get(key)
        rows.append(row)
    return export_response(rows, EFFORT_ESTIMATES.export_columns, f"{slug}-effort-estimates.xlsx")


@router.post("/effort-estimates/import")
async def import_effort_estimates(
    slug: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_project_db),
    _user: models.User = Depends(require_internal),
):
    """Creates (or updates) a Function per row and attaches its calculated
    effort estimate.

    The calculation runs through the same engine the UI uses, so imported
    man-days match what the spreadsheet computed — that is the whole point of
    the feature, and it is what the SATL round-trip test checks.
    """
    content = await file.read()
    try:
        records, report = read_rows(content, EFFORT_ESTIMATES)
    except ImportError_ as exc:
        raise_import_errors(exc)

    config = effort_budget.get_config(db)
    config_dict = effort_budget.config_as_dict(config)
    leverage = effort_budget.config_hil_leverage(config)
    driver_keys = {
        d[0]
        for group in (
            effort_calculator.SCREEN_DRIVERS,
            effort_calculator.REPORT_DRIVERS,
            effort_calculator.BATCH_DRIVERS,
        )
        for d in group
    }

    errors = []
    for index, record in enumerate(records):
        excel_row = index + 2
        if _work_type_of(record) is None:
            errors.append(
                {
                    "row": excel_row,
                    "column": "work_type_screen/report/batch",
                    "value": None,
                    "problem": "put 1 in exactly one of the three work_type columns",
                }
            )
        mode = record.get("delivery_mode") or "human"
        # The compliance guard applies to a spreadsheet exactly as it does to
        # the UI — a restricted project rejects the file rather than quietly
        # downgrading the rows to human.
        if mode == "human_in_loop" and config.hil_restricted:
            errors.append(
                {
                    "row": excel_row,
                    "column": "delivery_mode",
                    "value": mode,
                    "problem": "this project is contractually restricted to fully-human delivery",
                }
            )
    if errors:
        raise HTTPException(
            status_code=400,
            detail={
                "message": f"{len(errors)} row(s) could not be imported. Nothing was saved.",
                "errors": errors,
                "error_count": len(errors),
            },
        )

    existing = {f.function_code: f for f in db.query(models.Function).all() if f.function_code}
    created_functions = 0
    created_estimates = 0
    not_counted = 0

    for record in records:
        code = record.get("function_code")
        function = existing.get(code) if code else None
        if function is None:
            function = models.Function(
                function_code=code,
                name=record["name"],
                phase=record.get("phase"),
                owner=record.get("owner"),
                status=record.get("status") or "Draft",
                module=record.get("module"),
            )
            db.add(function)
            db.flush()
            created_functions += 1
            if code:
                existing[code] = function

        drivers = {k: v for k, v in record.items() if k in driver_keys and v not in (None, "")}
        priority = str(record.get("priority") or effort_calculator.COUNTED_PRIORITY)
        result = effort_calculator.calculate(
            work_type=_work_type_of(record),
            driver_counts=drivers,
            complexity=record.get("complexity"),
            non_similarity=record.get("non_similarity"),
            config=config_dict,
            priority=priority,
            delivery_mode=record.get("delivery_mode") or "human",
            hil_leverage=leverage,
        )
        if not result["counted"]:
            not_counted += 1

        db.add(
            models.EffortEstimate(
                linked_entity_type="function",
                linked_entity_id=function.id,
                work_type=result["work_type"],
                driver_counts_json=json.dumps(drivers),
                non_similarity_source=result["non_similarity_source"],
                priority=priority,
                complexity=result["complexity"],
                non_similarity=result["non_similarity"],
                delivery_mode=result["delivery_mode"],
                effort_multiplier_applied=result["effort_multiplier_applied"],
                man_days_human=result["man_days_human"],
                calculated_fp=result["fp"],
                calculated_final_fp=result["final_fp"],
                calculated_mm=result["mm"],
                calculated_man_days=result["man_days"],
                md_dr=result["md_dr"],
                md_dnpu=result["md_dnpu"],
                md_iftbct=result["md_iftbct"],
            )
        )
        created_estimates += 1

    db.commit()
    return {
        "imported": created_estimates,
        "functions_created": created_functions,
        "estimates_created": created_estimates,
        "not_counted": not_counted,
        "note": (
            f"{not_counted} row(s) scored 0 effort because their priority is not "
            f"'{effort_calculator.COUNTED_PRIORITY}' — matching the source spreadsheet."
        )
        if not_counted
        else None,
        **report,
    }


# ==========================================================================
# Schedule (plan dates + manual actual overrides)
# ==========================================================================

_CODE_ATTR = {
    "task": ("task_code", models.Task),
    "function": ("function_code", models.Function),
    "board_item": ("item_code", models.BoardItem),
}


@router.get("/schedule/import-template")
def schedule_template(slug: str):
    return template_response(SCHEDULE, "schedule-import-template.xlsx")


@router.get("/schedule/export")
def export_schedule(
    slug: str,
    db: Session = Depends(get_project_db),
    master_db: Session = Depends(get_master_db),
):
    rows = []
    matrix = progress_matrix.build_progress_matrix(
        slug=slug, db=db, master_db=master_db, entity_types=list(progress_matrix.ENTITY_MODELS)
    )
    for r in matrix["rows"]:
        rows.append(
            {
                "entity_type": r["entity_type"],
                "entity_code": r["entity_code"],
                "plan_start": r["plan_start"],
                "plan_end": r["plan_end"],
                "actual_start_override": r["actual_start_override"],
                "actual_end_override": r["actual_end_override"],
                "override_reason": r["override_reason"],
                "actual_start_derived": r["actual_start_derived"],
                "actual_end_derived": r["actual_end_derived"],
                "actual_start": r["actual_start"],
                "actual_end": r["actual_end"],
                "actual_start_source": r["actual_start_source"],
                "actual_end_source": r["actual_end_source"],
            }
        )
    return export_response(rows, SCHEDULE.export_columns, f"{slug}-schedule.xlsx")


@router.post("/schedule/import")
async def import_schedule(
    slug: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_project_db),
    _user: models.User = Depends(require_internal),
):
    """Bulk plan dates and manual actual dates, matched by entity code.

    Built for migrating a project whose history lives in another system: there
    is no activity_log to derive actuals from, so they are entered here and
    flagged as manually set in the matrix, exactly as if typed in one at a time.
    """
    content = await file.read()
    try:
        records, report = read_rows(content, SCHEDULE)
    except ImportError_ as exc:
        raise_import_errors(exc)

    # Resolve every code up front so a bad reference is reported with its row
    # rather than failing halfway through the file.
    lookups = {}
    for entity_type, (code_attr, model) in _CODE_ATTR.items():
        lookups[entity_type] = {
            getattr(obj, code_attr): obj.id
            for obj in db.query(model).all()
            if getattr(obj, code_attr, None)
        }

    errors = []
    resolved = []
    for index, record in enumerate(records):
        excel_row = index + 2
        entity_type = record["entity_type"]
        code = str(record["entity_code"])
        entity_id = lookups.get(entity_type, {}).get(code)
        if entity_id is None:
            errors.append(
                {
                    "row": excel_row,
                    "column": "entity_code",
                    "value": code,
                    "problem": f"no {entity_type} with this code exists in the project",
                }
            )
            continue
        plan_start, plan_end = record.get("plan_start"), record.get("plan_end")
        if plan_start and plan_end and plan_end < plan_start:
            errors.append({"row": excel_row, "column": "plan_end", "value": str(plan_end), "problem": "is before plan_start"})
        a_start, a_end = record.get("actual_start_override"), record.get("actual_end_override")
        if a_start and a_end and a_end < a_start:
            errors.append(
                {"row": excel_row, "column": "actual_end_override", "value": str(a_end), "problem": "is before actual_start_override"}
            )
        resolved.append((entity_type, entity_id, record))

    if errors:
        raise HTTPException(
            status_code=400,
            detail={
                "message": f"{len(errors)} row(s) could not be imported. Nothing was saved.",
                "errors": errors,
                "error_count": len(errors),
            },
        )

    plan_set = 0
    overrides_set = 0
    for entity_type, entity_id, record in resolved:
        plan_start, plan_end = record.get("plan_start"), record.get("plan_end")
        if plan_start or plan_end:
            progress_matrix.upsert_plan_dates(db, entity_type, entity_id, plan_start, plan_end)
            plan_set += 1
        a_start, a_end = record.get("actual_start_override"), record.get("actual_end_override")
        if a_start or a_end:
            progress_matrix.upsert_actual_override(
                db, entity_type, entity_id, a_start, a_end, record.get("override_reason"), "import"
            )
            overrides_set += 1

    return {
        "imported": len(resolved),
        "plan_dates_set": plan_set,
        "actual_overrides_set": overrides_set,
        **report,
    }
