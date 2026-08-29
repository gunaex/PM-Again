"""End-to-end coverage for the three imports exposed by the core list views."""

import io

from openpyxl import load_workbook


def _template_with_row(template_bytes: bytes, values: dict) -> bytes:
    workbook = load_workbook(io.BytesIO(template_bytes))
    sheet = workbook["Data"]
    columns = {cell.value: cell.column for cell in sheet[1]}
    for name, value in values.items():
        sheet.cell(row=2, column=columns[name], value=value)
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


def test_function_task_and_gantt_templates_can_be_imported(auth_client):
    project = auth_client.post(
        "/api/projects",
        json={"name": "Core import API", "project_code": "CIA"},
    )
    assert project.status_code == 200, project.text
    slug = project.json()["slug"]

    cases = (
        ("functions", {"name": "Import function", "type": "Functional", "phase": "UR"}),
        ("tasks", {"title": "Import task", "phase": "UR", "is_followup": False}),
        (
            "gantt",
            {"name": "Import schedule", "phase": "UR", "start_date": "2026-08-31", "end_date": "2026-09-04"},
        ),
    )

    for entity, values in cases:
        template = auth_client.get(f"/api/{slug}/{entity}/import-template")
        assert template.status_code == 200, template.text
        upload = _template_with_row(template.content, values)
        response = auth_client.post(
            f"/api/{slug}/{entity}/import",
            files={"file": (f"{entity}.xlsx", upload, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
        assert response.status_code == 200, response.text
        assert response.json()["imported"] == 1
