from flask import Flask, render_template, request

from src.summarize_matches import load_url, normalize_dataframe, summarize

app = Flask(__name__)


@app.route("/", methods=["GET", "POST"])
def index():
    match_url = ""
    error = None
    records = None
    summary = None

    if request.method == "POST":
        match_url = request.form.get("match_url", "").strip()
        if not match_url:
            error = "Ange en matchlänk."
        else:
            try:
                df = load_url(match_url)
                df = normalize_dataframe(df)
                records = df.to_dict(orient="records")
                summary = summarize(df)
            except Exception as exc:
                error = str(exc)

    return render_template(
        "index.html",
        match_url=match_url,
        error=error,
        records=records,
        summary=summary,
    )


if __name__ == "__main__":
    app.run(debug=True, port=5000)
