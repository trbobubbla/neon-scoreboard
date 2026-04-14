import argparse
import json
import sys
from pathlib import Path

import pandas as pd
import requests
from bs4 import BeautifulSoup


def is_url(path: str) -> bool:
    return path.startswith("http://") or path.startswith("https://")


def load_file(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix == ".json":
        return pd.read_json(path, orient="records")
    raise ValueError(f"Stöds inte filtyp: {path}")


def parse_html_table(table) -> pd.DataFrame:
    rows = []
    headers = [th.get_text(strip=True) for th in table.find_all("th")]
    for tr in table.find_all("tr"):
        cols = [td.get_text(strip=True) for td in tr.find_all(["td", "th"])]
        if not cols:
            continue
        if headers and len(cols) == len(headers):
            rows.append(dict(zip(headers, cols)))
        elif len(cols) >= 2:
            rows.append({"field": cols[0], "value": " ".join(cols[1:])})
    return pd.DataFrame(rows)


def load_url(url: str) -> pd.DataFrame:
    response = requests.get(url, timeout=15, headers={"User-Agent": "ESSPortalReport/1.0"})
    response.raise_for_status()

    content_type = response.headers.get("Content-Type", "")
    if "application/json" in content_type:
        payload = response.json()
        if isinstance(payload, list):
            return pd.DataFrame(payload)
        if isinstance(payload, dict):
            return pd.json_normalize(payload)

    soup = BeautifulSoup(response.text, "html.parser")

    table = soup.find("table")
    if table:
        return parse_html_table(table)

    definition_list = soup.find("dl")
    if definition_list:
        rows = []
        terms = definition_list.find_all("dt")
        descriptions = definition_list.find_all("dd")
        for term, desc in zip(terms, descriptions):
            rows.append({"field": term.get_text(strip=True), "value": desc.get_text(strip=True)})
        return pd.DataFrame(rows)

    key_values = []
    for row in soup.find_all(["p", "li"]):
        text = row.get_text(separator=" ", strip=True)
        if ":" in text:
            key, value = text.split(":", 1)
            key_values.append({"field": key.strip(), "value": value.strip()})

    if key_values:
        return pd.DataFrame(key_values)

    title = soup.title.string.strip() if soup.title else url
    return pd.DataFrame([{"field": "title", "value": title}, {"field": "url", "value": url}])


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


def merge_inputs(inputs: list[str]) -> pd.DataFrame:
    frames = []
    for input_path in inputs:
        if is_url(input_path):
            df = load_url(input_path)
            df["source_url"] = input_path
        else:
            path = Path(input_path)
            df = load_file(path)
            df["source_file"] = path.name
        df = normalize_dataframe(df)
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
    parser.add_argument("--input", "-i", nargs="+", required=True, help="En eller flera sambandade inputfiler (CSV, JSON eller URL).")
    parser.add_argument("--output", "-o", required=True, help="Utdatafil för den kombinerade listan (CSV eller JSON).")
    parser.add_argument("--summary", "-s", default="results/summary.json", help="Fil för sammanfattande statistik.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    for path in args.input:
        if not is_url(path) and not Path(path).exists():
            print(f"Filen finns inte: {path}", file=sys.stderr)
            return 1

    combined = merge_inputs(args.input)
    write_output(combined, Path(args.output))
    summary = summarize(combined)
    write_summary(summary, Path(args.summary))

    print(f"Kombinerat resultat sparat till: {args.output}")
    print(f"Sammanfattning sparad till: {args.summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
