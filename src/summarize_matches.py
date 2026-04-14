import argparse
import json
import os
import sys
from pathlib import Path

import pandas as pd


def load_file(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix == ".json":
        return pd.read_json(path, orient="records")
    raise ValueError(f"Stöds inte filtyp: {path}")


def normalize_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "score" in df.columns:
        df["score"] = pd.to_numeric(df["score"], errors="coerce")
    return df


def summarize(df: pd.DataFrame) -> dict:
    result = {
        "row_count": int(len(df)),
        "columns": list(df.columns),
        "stats": {},
    }

    numeric_columns = df.select_dtypes(include=["number"]).columns
    for column in numeric_columns:
        result["stats"][column] = {
            "count": int(df[column].count()),
            "mean": float(df[column].mean()) if len(df[column].dropna()) else None,
            "min": float(df[column].min()) if len(df[column].dropna()) else None,
            "max": float(df[column].max()) if len(df[column].dropna()) else None,
        }

    if "match_id" in df.columns:
        result["unique_matches"] = int(df["match_id"].nunique())
    return result


def merge_inputs(inputs: list[Path]) -> pd.DataFrame:
    frames = []
    for input_path in inputs:
        df = load_file(input_path)
        df = normalize_dataframe(df)
        df["source_file"] = input_path.name
        frames.append(df)
    if not frames:
        raise ValueError("Ingen inputfil angiven.")
    return pd.concat(frames, ignore_index=True)


def write_output(df: pd.DataFrame, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    suffix = output_path.suffix.lower()
    if suffix == ".csv":
        df.to_csv(output_path, index=False)
    elif suffix == ".json":
        df.to_json(output_path, orient="records", force_ascii=False, indent=2)
    else:
        raise ValueError(f"Utdataformat stöds inte: {output_path}")


def write_summary(summary: dict, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as fd:
        json.dump(summary, fd, ensure_ascii=False, indent=2)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sammanställ ESSPortal-matcher och statistik.")
    parser.add_argument("--input", "-i", nargs="+", required=True, help="En eller flera sambandade inputfiler (CSV eller JSON).")
    parser.add_argument("--output", "-o", required=True, help="Utdatafil för den kombinerade listan (CSV eller JSON).")
    parser.add_argument("--summary", "-s", default="results/summary.json", help="Fil för sammanfattande statistik.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_paths = [Path(path) for path in args.input]

    for path in input_paths:
        if not path.exists():
            print(f"Filen finns inte: {path}", file=sys.stderr)
            return 1

    combined = merge_inputs(input_paths)
    write_output(combined, Path(args.output))
    summary = summarize(combined)
    write_summary(summary, Path(args.summary))

    print(f"Kombinerat resultat sparat till: {args.output}")
    print(f"Sammanfattning sparad till: {args.summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
