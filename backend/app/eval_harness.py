from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from dataclasses import dataclass
from typing import Any
from urllib import parse as url_parse
from urllib import request as url_request


@dataclass(frozen=True)
class QueryCase:
    query: str
    relevant_topics: tuple[str, ...]
    relevant_tasks: tuple[str, ...]
    relevant_logs: tuple[str, ...]
    results: dict[str, list[str]]


def _safe_float(value: float) -> float:
    if value != value:  # NaN check
        return 0.0
    return float(value)


def recall_at_k(ranked: list[str], relevant: set[str], k: int) -> float:
    if not relevant:
        return 0.0
    top_k = ranked[: max(1, k)]
    hit = len([item for item in top_k if item in relevant])
    return _safe_float(hit / len(relevant))


def reciprocal_rank(ranked: list[str], relevant: set[str]) -> float:
    if not relevant:
        return 0.0
    for idx, item in enumerate(ranked, start=1):
        if item in relevant:
            return _safe_float(1.0 / idx)
    return 0.0


def ndcg_at_k(ranked: list[str], relevant: set[str], k: int) -> float:
    if not relevant:
        return 0.0
    top_k = ranked[: max(1, k)]
    dcg = 0.0
    for idx, item in enumerate(top_k, start=1):
        if item in relevant:
            dcg += 1.0 / (1.0 if idx == 1 else math.log2(idx + 1))
    ideal_hits = min(len(relevant), len(top_k))
    if ideal_hits <= 0:
        return 0.0
    idcg = 0.0
    for idx in range(1, ideal_hits + 1):
        idcg += 1.0 / (1.0 if idx == 1 else math.log2(idx + 1))
    if idcg <= 0:
        return 0.0
    return _safe_float(dcg / idcg)


def dedupe_precision(pairs: list[dict[str, Any]]) -> float:
    predicted_positive = [pair for pair in pairs if bool(pair.get("predictedMatch"))]
    if not predicted_positive:
        return 0.0
    true_positive = [pair for pair in predicted_positive if bool(pair.get("shouldMatch"))]
    return _safe_float(len(true_positive) / len(predicted_positive))


def dedupe_recall(pairs: list[dict[str, Any]]) -> float:
    actual_positive = [pair for pair in pairs if bool(pair.get("shouldMatch"))]
    if not actual_positive:
        return 0.0
    true_positive = [pair for pair in actual_positive if bool(pair.get("predictedMatch"))]
    return _safe_float(len(true_positive) / len(actual_positive))


def dedupe_f1(precision: float, recall: float) -> float:
    if precision <= 0 or recall <= 0:
        return 0.0
    return _safe_float((2.0 * precision * recall) / (precision + recall))


def _extract_ranked_ids(results: dict[str, Any], key: str) -> list[str]:
    rows = results.get(key)
    if not isinstance(rows, list):
        return []
    ranked: list[str] = []
    for item in rows:
        if isinstance(item, str):
            ranked.append(item)
            continue
        if isinstance(item, dict):
            candidate_id = str(item.get("id") or "").strip()
            if candidate_id:
                ranked.append(candidate_id)
    return ranked


def _coerce_case(raw: dict[str, Any]) -> QueryCase:
    relevant = raw.get("relevant") if isinstance(raw.get("relevant"), dict) else {}
    results = raw.get("results") if isinstance(raw.get("results"), dict) else {}
    return QueryCase(
        query=str(raw.get("query") or ""),
        relevant_topics=tuple(str(item) for item in (relevant.get("topics") or []) if str(item)),
        relevant_tasks=tuple(str(item) for item in (relevant.get("tasks") or []) if str(item)),
        relevant_logs=tuple(str(item) for item in (relevant.get("logs") or []) if str(item)),
        results={
            "topics": _extract_ranked_ids(results, "topics"),
            "tasks": _extract_ranked_ids(results, "tasks"),
            "logs": _extract_ranked_ids(results, "logs"),
        },
    )


def _search_api(api_base: str, token: str | None, query: dict[str, Any]) -> dict[str, Any]:
    params = {"q": str(query.get("query") or "")}
    if query.get("topicId"):
        params["topicId"] = str(query["topicId"])
    if query.get("sessionKey"):
        params["sessionKey"] = str(query["sessionKey"])
    if query.get("includePending") is not None:
        params["includePending"] = "true" if bool(query["includePending"]) else "false"
    params["limitTopics"] = str(int(query.get("limitTopics") or 120))
    params["limitTasks"] = str(int(query.get("limitTasks") or 320))
    params["limitLogs"] = str(int(query.get("limitLogs") or 1200))

    url = f"{api_base.rstrip('/')}/api/search?{url_parse.urlencode(params)}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Clawboard-Token"] = token
    req = url_request.Request(url, method="GET", headers=headers)
    with url_request.urlopen(req, timeout=12) as response:
        payload = response.read().decode("utf-8")
        return json.loads(payload)


def evaluate(cases: list[QueryCase], ks: tuple[int, ...] = (1, 3, 5, 10)) -> dict[str, float]:
    if not cases:
        return {}

    metrics: dict[str, list[float]] = defaultdict(list)
    for case in cases:
        ranked_topics = list(case.results.get("topics") or [])
        ranked_tasks = list(case.results.get("tasks") or [])
        ranked_logs = list(case.results.get("logs") or [])
        rel_topics = set(case.relevant_topics)
        rel_tasks = set(case.relevant_tasks)
        rel_logs = set(case.relevant_logs)

        metrics["topic_mrr"].append(reciprocal_rank(ranked_topics, rel_topics))
        metrics["task_mrr"].append(reciprocal_rank(ranked_tasks, rel_tasks))
        metrics["log_mrr"].append(reciprocal_rank(ranked_logs, rel_logs))

        for k in ks:
            metrics[f"topic_recall@{k}"].append(recall_at_k(ranked_topics, rel_topics, k))
            metrics[f"task_recall@{k}"].append(recall_at_k(ranked_tasks, rel_tasks, k))
            metrics[f"log_recall@{k}"].append(recall_at_k(ranked_logs, rel_logs, k))
            metrics[f"topic_ndcg@{k}"].append(ndcg_at_k(ranked_topics, rel_topics, k))
            metrics[f"task_ndcg@{k}"].append(ndcg_at_k(ranked_tasks, rel_tasks, k))
            metrics[f"log_ndcg@{k}"].append(ndcg_at_k(ranked_logs, rel_logs, k))

    return {name: _safe_float(sum(values) / max(1, len(values))) for name, values in metrics.items()}


def run_eval(payload: dict[str, Any], api_base: str | None = None, token: str | None = None) -> dict[str, Any]:
    raw_queries = payload.get("queries")
    if not isinstance(raw_queries, list):
        raise ValueError("payload.queries must be an array")

    enriched_queries: list[dict[str, Any]] = []
    for raw in raw_queries:
        if not isinstance(raw, dict):
            continue
        query_item = dict(raw)
        if "results" not in query_item:
            if not api_base:
                raise ValueError("query.results missing and api_base not provided")
            query_item["results"] = _search_api(api_base, token, query_item)
        enriched_queries.append(query_item)

    cases = [_coerce_case(item) for item in enriched_queries]
    metric_values = evaluate(cases)

    dedupe_block = payload.get("dedupe") if isinstance(payload.get("dedupe"), dict) else {}
    topic_pairs = dedupe_block.get("topics") if isinstance(dedupe_block.get("topics"), list) else []
    task_pairs = dedupe_block.get("tasks") if isinstance(dedupe_block.get("tasks"), list) else []

    topic_precision = dedupe_precision(topic_pairs)
    topic_recall_value = dedupe_recall(topic_pairs)
    task_precision = dedupe_precision(task_pairs)
    task_recall_value = dedupe_recall(task_pairs)

    metric_values["topic_dedupe_precision"] = topic_precision
    metric_values["topic_dedupe_recall"] = topic_recall_value
    metric_values["topic_dedupe_f1"] = dedupe_f1(topic_precision, topic_recall_value)
    metric_values["task_dedupe_precision"] = task_precision
    metric_values["task_dedupe_recall"] = task_recall_value
    metric_values["task_dedupe_f1"] = dedupe_f1(task_precision, task_recall_value)

    return {
        "queryCount": len(cases),
        "metrics": metric_values,
    }


def main():
    parser = argparse.ArgumentParser(description="Evaluate Clawboard retrieval and dedupe metrics.")
    parser.add_argument("--input", required=True, help="Path to eval dataset JSON.")
    parser.add_argument("--api-base", default=None, help="API base URL (optional, for live querying).")
    parser.add_argument("--token", default=None, help="API token for protected environments.")
    parser.add_argument("--output", default=None, help="Optional output path for report JSON.")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        payload = json.load(f)
    report = run_eval(payload, api_base=args.api_base, token=args.token)
    content = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(content + "\n")
    else:
        print(content)


if __name__ == "__main__":
    main()
