"""Single source of truth for every import/export column set.

Templates, import validation and export all read from here, so the three can
no longer drift apart — which is what happened when each router kept its own
hardcoded list and new model fields never made it into the spreadsheets.

Every model column belongs to exactly one of three groups:

    IMPORTABLE   accepted on import, offered in the template
    EXPORT_ONLY  emitted on export so the reader can see it, silently ignored
                 on import (computed, derived, or workflow-controlled)
    IGNORED      never in either direction (surrogate keys, timestamps)

The three groups must together account for every column on the model. A test
enforces that, so adding a field forces a deliberate decision about whether a
spreadsheet may set it — rather than it being quietly forgotten.

EXPORT_ONLY exists specifically so a round-trip works: export emits those
columns, import sees them and skips them without complaining. Anything in the
file that is in none of the three groups is a real mistake and is reported.
"""

from dataclasses import dataclass, field
from typing import Optional

from . import models

# --------------------------------------------------------------------------
# Enumerations
# --------------------------------------------------------------------------
# The company phase enum. Anything outside this is rejected on import.
PHASES = ("UR", "DR", "DN", "PU", "ST", "UT", "TR", "IP", "MA")

# Phase values from the pre-rename era. Accepted on import and converted, so a
# spreadsheet the team already has keeps working without hand-editing — the
# same mapping database.py applies to rows already stored.
LEGACY_PHASE_MAP = {
    "PU-PT": "PU",
    "IFT": "ST",
    "BCT": "ST",
    "UAT": "UT",
}

FUNCTION_TYPES = ("Functional", "Non-Functional")
FUNCTION_STATUSES = ("Draft", "Confirmed", "InProgress", "Done")
MOSCOW = ("Must", "Should", "Could", "Won't")
SCOPE_CLASSES = ("Core", "Core/Overlap", "Extended")
COMPLEXITIES = ("Low", "Medium", "High")
PERFORMANCE_CLASSES = ("Batch/Async", "Transactional", "Calculation/CRUD")

TASK_STATUSES = ("Todo", "InProgress", "Done", "Blocked")
TASK_PRIORITIES = ("Low", "Med", "High")

BOARD_ITEM_TYPES = ("issue", "incident", "backlog")
SEVERITIES = ("Low", "Medium", "High", "Critical")
# One column, three lifecycles — validated against the union, then checked
# against the flavour's own list in the board-item importer.
BOARD_STATUSES = ("Open", "InProgress", "Resolved", "Closed", "Promoted", "Backlog", "Planned", "Done")
BOARD_STATUSES_BY_TYPE = {
    "issue": ("Open", "InProgress", "Resolved", "Closed", "Promoted"),
    "incident": ("Open", "InProgress", "Resolved", "Closed", "Promoted"),
    "backlog": ("Backlog", "Planned", "InProgress", "Done", "Promoted"),
}

DOCUMENT_STATUSES = ("Draft", "InReview", "Confirmed", "Rejected")

DELIVERY_MODES = ("human", "human_in_loop")
WORK_TYPES = ("screen", "batch", "report")
PROGRESS_ENTITY_TYPES = ("task", "function", "board_item")

BOOLEANS = ("TRUE", "FALSE")


@dataclass
class ImportSchema:
    entity: str
    model: Optional[type]
    importable: list
    export_only: list = field(default_factory=list)
    ignored: list = field(default_factory=list)
    # column -> allowed values. Drives both import rejection and the
    # dropdown written into the generated template.
    enums: dict = field(default_factory=dict)
    required: list = field(default_factory=list)
    # Columns that appear on export but aren't model attributes at all
    # (joined from another table). Never importable.
    derived_export: list = field(default_factory=list)
    notes: dict = field(default_factory=dict)
    # Columns that must end up as real `date` objects. Excel hands these over
    # as a Timestamp when the cell is date-formatted and as plain text when it
    # isn't, and the difference is invisible to whoever filled the sheet in —
    # so both are coerced rather than one of them exploding at the DB layer.
    dates: list = field(default_factory=list)

    @property
    def template_columns(self) -> list:
        """What the blank template offers. Export-only columns are left out
        so nobody fills in a value that would be silently discarded."""
        return list(self.importable)

    @property
    def export_columns(self) -> list:
        return list(self.importable) + list(self.export_only) + list(self.derived_export)

    def known(self, column: str) -> bool:
        return (
            column in self.importable
            or column in self.export_only
            or column in self.ignored
            or column in self.derived_export
        )


# --------------------------------------------------------------------------
# Per-entity schemas
# --------------------------------------------------------------------------

FUNCTIONS = ImportSchema(
    entity="functions",
    model=models.Function,
    importable=[
        "function_code",
        "name",
        "description",
        "type",
        "phase",
        "owner",
        "status",
        "module",
        "priority",
        "scope_class",
        "complexity",
        "pd_ba",
        "pd_ux",
        "pd_fe",
        "pd_be",
        "pd_int_data",
        "pd_qa",
        "pd_devops",
        "performance_class",
        "target_option_a",
        "target_option_b",
        "target_option_c",
        "performance_note",
        "price_thb",
        "commercial_note",
    ],
    # Server sums the pd_* columns on every write, so a hand-entered value was
    # always discarded. It stays visible on export and is called out in the
    # template instructions instead of pretending to be an input.
    export_only=["pd_total"],
    ignored=["id", "created_at", "updated_at"],
    enums={
        "type": FUNCTION_TYPES,
        "phase": PHASES,
        "status": FUNCTION_STATUSES,
        "priority": MOSCOW,
        "scope_class": SCOPE_CLASSES,
        "complexity": COMPLEXITIES,
        "performance_class": PERFORMANCE_CLASSES,
    },
    required=["name"],
    notes={"pd_total": "Calculated automatically from the pd_* columns — do not fill in."},
)

TASKS = ImportSchema(
    entity="tasks",
    model=models.Task,
    importable=[
        "task_code",
        "title",
        "description",
        "phase",
        "owner",
        "due_date",
        "status",
        "priority",
        "is_followup",
        "linked_function_id",
    ],
    ignored=["id", "created_at"],
    enums={"phase": PHASES, "status": TASK_STATUSES, "priority": TASK_PRIORITIES, "is_followup": BOOLEANS},
    required=["title"],
    dates=["due_date"],
)

GANTT_ITEMS = ImportSchema(
    entity="gantt",
    model=models.GanttItem,
    importable=[
        "name",
        "phase",
        "start_date",
        "end_date",
        "progress",
        "dependencies",
        "linked_task_id",
        "is_milestone",
        "baseline_start",
        "baseline_end",
    ],
    # linked_entity_* is maintained by the app (backfill + the plan-dates
    # endpoint). Setting it from a sheet would let a row claim to belong to an
    # entity that doesn't own it. Use the Schedule Import for that instead.
    export_only=["linked_entity_type", "linked_entity_id", "google_calendar_event_id"],
    ignored=["id"],
    enums={"phase": PHASES, "is_milestone": BOOLEANS},
    required=["name", "start_date", "end_date"],
    dates=["start_date", "end_date", "baseline_start", "baseline_end"],
    notes={
        "linked_entity_type": "Maintained by the app — set plan dates via the Progress Matrix or Schedule Import.",
        "linked_entity_id": "Maintained by the app.",
    },
)

BOARD_ITEMS = ImportSchema(
    entity="board-items",
    model=models.BoardItem,
    importable=["item_type", "item_code", "title", "description", "severity", "status", "phase", "owner"],
    # sla_due_date is derived from severity via the business-day engine;
    # the link/promotion columns are set by the promote workflow.
    export_only=["sla_due_date", "linked_task_id", "linked_note_id", "promoted_from_id"],
    ignored=["id", "created_at", "updated_at"],
    enums={
        "item_type": BOARD_ITEM_TYPES,
        "severity": SEVERITIES,
        "status": BOARD_STATUSES,
        "phase": PHASES,
    },
    required=["item_type", "title"],
    dates=["sla_due_date"],
    notes={"sla_due_date": "Calculated from severity using the Thai business-day calendar."},
)

DOCUMENTS = ImportSchema(
    entity="documents",
    model=models.Document,
    importable=["doc_code", "title", "phase", "doc_type", "owner"],
    # `status` is deliberately NOT importable: a document reaches Confirmed by
    # going through sign-off, and letting a spreadsheet write that value would
    # walk straight past the approval the status is meant to evidence. Imported
    # documents start at Draft.
    export_only=["status", "version", "file_path", "google_drive_file_id"],
    ignored=["id", "created_at", "updated_at"],
    derived_export=["last_signed_by", "last_signed_at", "last_signoff_status"],
    enums={"phase": PHASES},
    required=["title"],
    notes={
        "status": "Set by the sign-off workflow — imported documents always start at Draft.",
        "version": "Incremented by the app.",
        "last_signed_by": "From the sign-off history, not a field on the document.",
    },
)

NOTE_PAGES = ImportSchema(
    entity="note-pages",
    model=models.NotePage,
    importable=["title", "content_markdown", "created_by"],
    ignored=["id", "created_at", "updated_at"],
    required=["title"],
    notes={
        "content_markdown": "Hashtags and [[wiki-links]] are re-indexed from this text on import, "
        "exactly as they are when a note is saved in the app."
    },
)

# --------------------------------------------------------------------------
# Schemas whose columns are not a model's columns
# --------------------------------------------------------------------------

# FP effort import. Column order follows SATL_Function_List.xlsx so the real
# spreadsheet can be imported with minimal reshaping. Driver names are taken
# from effort_calculator so they cannot drift from the engine.
def _driver_columns() -> list:
    from .effort_calculator import BATCH_DRIVERS, REPORT_DRIVERS, SCREEN_DRIVERS

    return [d[0] for d in SCREEN_DRIVERS] + [d[0] for d in REPORT_DRIVERS] + [d[0] for d in BATCH_DRIVERS]


EFFORT_ESTIMATES = ImportSchema(
    entity="effort-estimates",
    model=None,
    importable=[
        "function_code",
        "name",
        "phase",
        "owner",
        "status",
        "module",
        "priority",
        # Work type as three 1/0 flags, matching the source spreadsheet's own
        # layout rather than forcing the user to convert to an enum.
        "work_type_screen",
        "work_type_report",
        "work_type_batch",
        "complexity",
        "non_similarity",
        "standard_mm",
        "delivery_mode",
    ]
    + _driver_columns(),
    export_only=["calculated_fp", "calculated_final_fp", "calculated_mm", "calculated_man_days", "md_dr", "md_dnpu", "md_iftbct", "not_counted_reason"],
    enums={"phase": PHASES, "status": FUNCTION_STATUSES, "delivery_mode": DELIVERY_MODES},
    required=["name"],
    notes={
        "priority": "Only 'M' counts towards effort — anything else scores 0, matching the source spreadsheet.",
        "work_type_screen": "Put 1 in exactly one of the three work_type columns.",
        "calculated_man_days": "Computed by the Function Point engine on import.",
    },
)

SCHEDULE = ImportSchema(
    entity="schedule",
    model=None,
    importable=[
        "entity_type",
        "entity_code",
        "plan_start",
        "plan_end",
        "actual_start_override",
        "actual_end_override",
        "override_reason",
    ],
    enums={"entity_type": PROGRESS_ENTITY_TYPES},
    required=["entity_type", "entity_code"],
    dates=["plan_start", "plan_end", "actual_start_override", "actual_end_override"],
    derived_export=[
        "actual_start_derived",
        "actual_end_derived",
        "actual_start",
        "actual_end",
        "actual_start_source",
        "actual_end_source",
    ],
    notes={
        "actual_start_override": "Only for work with no activity log to derive from — the entered date is "
        "flagged in the Progress Matrix as manually set.",
        "actual_start_derived": "Read-only actual start derived from the activity log's status changes.",
        "actual_end_derived": "Read-only actual end derived from the activity log's status changes.",
        "actual_start": "Read-only effective start used by the Matrix: override when present, otherwise derived.",
        "actual_end": "Read-only effective end used by the Matrix: override when present, otherwise derived.",
        "actual_start_source": "Read-only: 'override' or 'derived'.",
        "actual_end_source": "Read-only: 'override' or 'derived'.",
    },
)


SCHEMAS = {
    s.entity: s
    for s in (FUNCTIONS, TASKS, GANTT_ITEMS, BOARD_ITEMS, DOCUMENTS, NOTE_PAGES, EFFORT_ESTIMATES, SCHEDULE)
}

# Entities deliberately left without an import path, and why. Referenced by
# the drift test so "missing" and "intentionally absent" stay distinguishable.
NO_IMPORT_BY_DESIGN = {
    "note_tags": "Derived by parsing note markdown on save — importing directly would break the "
    "invariant that tags always match the note body.",
    "note_links": "Derived the same way as note_tags.",
    "effort_estimate_config": "One row per project, edited in Project Settings. Not a bulk operation.",
    "change_request_impacts": "A child of a change request; would have to be imported with its parent.",
    "change_requests": "A CR is created through a workflow with a sign-off gate. Importing one would "
    "walk past that gate; if it is ever added, imported CRs must be forced to Draft.",
}
