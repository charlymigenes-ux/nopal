from pathlib import Path

MODEL_EXTENSIONS = {
    ".stl",
    ".3mf",
    ".obj",
    ".step",
    ".stp",
    ".gcode"
}


def get_models():
    models_path = Path("models")

    if not models_path.exists():
        return []

    files = []

    for file in models_path.iterdir():
        if file.is_file() and file.suffix.lower() in MODEL_EXTENSIONS:
            files.append({
                "name": file.name,
                "extension": file.suffix.lower(),
                "size": round(file.stat().st_size / 1024, 2)
            })

    return sorted(files, key=lambda x: x["name"].lower())
