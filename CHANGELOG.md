# Changelog

## Unreleased

**Changed default.** `mindgraph-tools`: `withMindGraph` (AI SDK and OpenAI) now searches with the latest user message and the one before it. Until now it searched with the latest message alone; set `userMessages: 1` to keep that. The new option `userMessages` sets how many of the latest user messages form the recall query (default 2). With 2, a follow-up that does not name its subject is searched together with the message before it. On synthetic sessions that move between subjects this raised answer accuracy from 0.41 to 0.68 with no loss on the turns that name a new subject; with 4 those turns lost 12 points, so 2 is the setting to use. Not measured on real conversations.

`mindgraph-eve`, `mindgraph-agent-core`: a recall query built from several user messages no longer loses the latest one. The query was the messages joined and cut at 500 characters from the start, so long earlier messages could push the current question out of the search. The latest message is now kept whole, earlier ones share what is left, nearest first, and messages with no text are skipped. `mindgraph-eve` builds its query from three messages by default, so this changes its queries when earlier messages are long. `recentUserText` takes an optional third argument to leave out user-role messages that are not the user's words, and at most 8 messages.

## 0.2.0

Add capability-checked, Space-bound profile recall and scoped context recall. Incomplete profiles report their omitted/unavailable sections; profile replacement preserves unrelated prompt blocks. All three packages share 0.2.0 and pin mindgraph-agent-core exactly.

Recognize OpenAI Responses `input_text`/`output_text` parts for recall and remove carried profile-only text parts during refresh. Multimodal input and unrelated instructions remain intact.

Profile recall requires TS SDK 0.18.0 and a server advertising memory.v1. The >=0.16.0 peer range and 0.16.0 development fixture intentionally retain legacy query/capture compatibility; missing profile capabilities report profile_unavailable and fail open. Qualification must also install the packed 0.18.0 SDK.
