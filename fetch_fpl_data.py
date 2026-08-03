#!/usr/bin/env python3
"""
Pull the current Fantasy Premier League dataset and write the three JSON
files the dashboard reads.

    python fetch_fpl_data.py

Writes players.json, teams.json and fixtures.json next to itself.
Standard library only, so there is nothing to install.

The FPL API sends no CORS headers, which is why the browser can't call it
directly and this step exists at all.
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

API = "https://fantasy.premierleague.com/api"
DATA_DIR = os.path.dirname(os.path.abspath(__file__))
HEADERS = {"User-Agent": "fpl-predicted-points/1.0"}


def get(path):
    req = urllib.request.Request(f"{API}/{path}", headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def num(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def build_teams(bootstrap):
    return [
        {
            "id": t["id"],
            "name": t["name"],
            "short": t["short_name"],
            "sh": t.get("strength_overall_home") or 3,
            "sa": t.get("strength_overall_away") or 3,
        }
        for t in bootstrap["teams"]
    ]


def build_players(bootstrap):
    players = []
    for e in bootstrap["elements"]:
        if e.get("removed"):
            continue
        # element_type 5 is the manager slot in some seasons; skip anything
        # outside the four playing positions.
        if e["element_type"] not in (1, 2, 3, 4):
            continue

        full = f"{e.get('first_name', '')} {e.get('second_name', '')}".strip()
        players.append(
            {
                "i": e["id"],
                "n": e["web_name"],
                "fn": e.get("known_name") or full,
                "t": e["team"],
                "p": e["element_type"],
                "c": e["now_cost"],
                "s": e["status"],
                "ch": e.get("chance_of_playing_next_round"),
                "nw": e.get("news") or "",
                "mn": e.get("minutes", 0),
                "st": e.get("starts", 0),
                "g": e.get("goals_scored", 0),
                "a": e.get("assists", 0),
                "cs": e.get("clean_sheets", 0),
                "gc": e.get("goals_conceded", 0),
                "sv": e.get("saves", 0),
                "bo": e.get("bonus", 0),
                "yc": e.get("yellow_cards", 0),
                "xg": round(num(e.get("expected_goals_per_90")), 3),
                "xa": round(num(e.get("expected_assists_per_90")), 3),
                "xgc": round(num(e.get("expected_goals_conceded_per_90")), 3),
                "dc": round(num(e.get("defensive_contribution_per_90")), 2),
                "sv90": round(num(e.get("saves_per_90")), 2),
                "ppg": num(e.get("points_per_game")),
                "tp": e.get("total_points", 0),
                "sel": num(e.get("selected_by_percent")),
                "pen": e.get("penalties_order"),
            }
        )
    return players


def next_gameweek(bootstrap):
    for event in bootstrap["events"]:
        if event.get("is_next"):
            return event["id"]
    for event in bootstrap["events"]:
        if not event.get("finished"):
            return event["id"]
    return 1


def build_fixtures(fixtures, teams, from_gw):
    short = {t["id"]: t["short"] for t in teams}
    by_team = {str(t["id"]): [] for t in teams}

    for f in fixtures:
        gw = f.get("event")
        if gw is None or gw < from_gw:
            continue
        home, away = f["team_h"], f["team_a"]
        by_team[str(home)].append(
            {"gw": gw, "opp": short.get(away, "???"), "home": True,
             "diff": f.get("team_h_difficulty", 3)}
        )
        by_team[str(away)].append(
            {"gw": gw, "opp": short.get(home, "???"), "home": False,
             "diff": f.get("team_a_difficulty", 3)}
        )

    for team_fixtures in by_team.values():
        team_fixtures.sort(key=lambda x: x["gw"])

    return by_team


def write(name, payload):
    path = os.path.join(DATA_DIR, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(path) / 1024
    print(f"  wrote {name}  ({size:.0f} kB)")


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

    print("Fetching bootstrap-static ...")
    bootstrap = get("bootstrap-static/")
    print("Fetching fixtures ...")
    fixtures = get("fixtures/")

    season = (
        bootstrap.get("game_config", {})
        .get("settings", {})
        .get("static_content_url", "")
        .rstrip("/")
        .split("/")[-1]
        .replace("_", "/")
    ) or "current"

    teams = build_teams(bootstrap)
    players = build_players(bootstrap)
    from_gw = next_gameweek(bootstrap)

    write("teams.json", {"season": season, "generated": stamp, "teams": teams})
    write("players.json", {"season": season, "generated": stamp, "players": players})
    write(
        "fixtures.json",
        {
            "season": season,
            "generated": stamp,
            "next_gw": from_gw,
            "byTeam": build_fixtures(fixtures, teams, from_gw),
        },
    )

    print(f"\nDone. {len(players)} players across {len(teams)} clubs, from GW{from_gw}.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Fetch failed: {exc}", file=sys.stderr)
        sys.exit(1)
