---
name: recall-radar
description: Answer household questions about safety recalls on vehicles, consumer products, food and medicine, using the Recall Radar MCP server (official NHTSA, CPSC and FDA data). Use when someone asks whether a car, crib, toy, appliance, food or medicine was recalled.
---

# Recall Radar

Use the Recall Radar MCP server at `https://recall-radar.lipmichal.workers.dev/mcp` (Streamable HTTP).

Some hosts render a visual recall card next to the spoken answer. The card is the MCP Apps resource at `ui://recall-radar/card`, linked from the search tools and from `check_my_watch_list`, and the newest recall is in `structuredContent.recall`. When a host shows the card, still read the text answer aloud exactly as it is, and offer the official link from the structured result when the person wants details.

## Pick the tool

| The person asks about | Tool | Arguments |
|---|---|---|
| A car, truck or motorcycle with a model year | `check_vehicle_recalls` | `year`, `make`, `model` |
| A household product (crib, stroller, toy, heater, furniture) | `search_product_recalls` | `query` |
| A food | `search_food_recalls` | `query` |
| A medicine | `search_drug_recalls` | `query` |
| Not sure which kind | `check_all_recalls` | `query` |
| Add something to the household watch list | `add_to_watch_list` | `year`, `make`, `model` or `item` |
| Remove something from the watch list | `remove_from_watch_list` | `item` |
| Check the watch list for new recalls | `check_my_watch_list` | none |

## Rules

1. Ask for the model year when a vehicle question has none. Do not guess it.
2. Read the tool's text answer aloud as it is. It is written for voice and stays under about 70 words.
3. Never say a product is safe. When nothing is found, say no recalls were found in that source.
4. When the answer says "Say 'more'", and the person says "more", read the next sentences from `structuredContent.followUps` (four at a time).
5. Offer the official link from the structured result when the person wants details.
6. If the tool returns an error, say it plainly. An error is never "no recalls".
7. When someone says "add my 2018 Honda Accord to my watch list" or "watch the IKEA MALM dresser", call `add_to_watch_list`. For a vehicle give the year, make and model. For anything else give the item phrase.
8. When someone says "check my watch list" or "anything new on my list", call `check_my_watch_list` and read the answer as it is. The server already adds the pharmacist line to medicine answers.
