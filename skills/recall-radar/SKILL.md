---
name: recall-radar
description: Answer household questions about safety recalls on vehicles, consumer products, food and medicine, using the Recall Radar MCP server (official NHTSA, CPSC and FDA data). Use when someone asks whether a car, crib, toy, appliance, food or medicine was recalled.
---

# Recall Radar

Use the Recall Radar MCP server at `https://recall-radar.lipmichal.workers.dev/mcp` (Streamable HTTP).

## Pick the tool

| The person asks about | Tool | Arguments |
|---|---|---|
| A car, truck or motorcycle with a model year | `check_vehicle_recalls` | `year`, `make`, `model` |
| A household product (crib, stroller, toy, heater, furniture) | `search_product_recalls` | `query` |
| A food | `search_food_recalls` | `query` |
| A medicine | `search_drug_recalls` | `query` |
| Not sure which kind | `check_all_recalls` | `query` |

## Rules

1. Ask for the model year when a vehicle question has none. Do not guess it.
2. Read the tool's text answer aloud as it is. It is written for voice and stays under about 60 words.
3. Never say a product is safe. When nothing is found, say no recalls were found in that source.
4. When the answer says "Say 'more'", and the person says "more", read the next sentences from `structuredContent.followUps` (two at a time).
5. For medicine, add the line "Ask your pharmacist before you stop taking a medicine."
6. Offer the official link from the structured result when the person wants details.
7. If the tool returns an error, say it plainly. An error is never "no recalls".
