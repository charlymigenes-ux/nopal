import os
import re
from fastapi import APIRouter

router = APIRouter()

UPLOAD_FOLDER = "uploads"


def _estimate_print_time(filepath: str, extension: str) -> dict:
    size_bytes = os.path.getsize(filepath)
    size_mb = max(size_bytes / (1024 * 1024), 0.1)

    if extension == ".gcode":
        try:
            with open(filepath, "r", encoding="utf-8", errors="ignore") as handle:
                for line in handle.readlines()[:200]:
                    lower = line.lower()
                    if "estimated" in lower and "time" in lower:
                        match = re.search(r"(\d+)\s*:\s*(\d+)", line)
                        if match:
                            minutes = int(match.group(1)) * 60 + int(match.group(2))
                            return {
                                "estimated_time": f"{match.group(1)}h {match.group(2)}m",
                                "estimated_time_minutes": minutes,
                            }
        except Exception:
            pass

    multiplier = {".stl": 12, ".obj": 10, ".step": 8, ".stp": 8, ".3mf": 9, ".gcode": 6}.get(extension, 8)
    minutes = int(max(20, round(size_mb * multiplier)))
    hours, rem = divmod(minutes, 60)
    return {
        "estimated_time": f"{hours}h {rem}m" if hours else f"{minutes}m",
        "estimated_time_minutes": minutes,
    }


@router.get("/api/models")
async def get_models():
    files = []

    for idx, filename in enumerate(sorted(os.listdir(UPLOAD_FOLDER))):
        extension = os.path.splitext(filename)[1].lower()
        if extension not in {".stl", ".3mf", ".obj", ".step", ".stp", ".gcode"}:
            continue

        filepath = os.path.join(UPLOAD_FOLDER, filename)
        estimated = _estimate_print_time(filepath, extension)
        files.append(
            {
                "id": idx,
                "name": filename,
                "extension": extension,
                "size": os.path.getsize(filepath),
                "modified": int(os.path.getmtime(filepath)),
                "file_url": f"/uploads/{filename}",
                "view_url": f"/view/{filename}",
                "estimated_time": estimated["estimated_time"],
                "estimated_time_minutes": estimated["estimated_time_minutes"],
                "material": "PLA",
                "tags": ["#modelo3D", "#impresion3D"],
            }
        )

    return files
