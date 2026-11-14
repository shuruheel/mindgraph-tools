# Changelog

## 0.2.0

Add capability-checked, Space-bound profile recall and scoped context recall. Incomplete profiles report their omitted/unavailable sections; profile replacement preserves unrelated prompt blocks. All three packages share 0.2.0 and pin mindgraph-agent-core exactly.

Profile recall requires TS SDK 0.18.0 and a server advertising memory.v1. The >=0.16.0 peer range and 0.16.0 development fixture intentionally retain legacy query/capture compatibility; missing profile capabilities report profile_unavailable and fail open. Qualification must also install the packed 0.18.0 SDK.
