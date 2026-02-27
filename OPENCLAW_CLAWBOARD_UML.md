# OpenClaw <-> Clawboard Content System UML

This document models the full user-generated-content and LLM-content lifecycle between OpenClaw and Clawboard.

## 1) Component Topology (UML Class/Component View)

```mermaid
classDiagram
    class OpenClawRuntime {
      +message_received
      +message_sending
      +before_tool_call
      +after_tool_call
      +agent_end
      +before_agent_start
    }

    class ClawboardLoggerPlugin {
      +sanitizeMessageContent()
      +isClassifierPayloadText()
      +computeEffectiveSessionKey()
      +resolveRoutingScope()
      +sendAsync()
      +localDurableQueue(sqlite)
    }

    class ClawboardAPI {
      +post_api_log()
      +post_api_ingest()
      +patch_api_log_by_id()
      +get_classifier_pending()
      +get_post_classifier_session_routing()
      +get_api_context()
      +get_api_search()
      +post_openclaw_chat()
      +delete_openclaw_chat()
      +get_openclaw_chat_dispatch_status()
      +post_openclaw_chat_dispatch_quarantine()
      +get_openclaw_history_sync_status()
      +get_api_stream()
      +get_api_changes()
    }

    class EventHubSSE {
      +publish()
      +replay()
      +stream.reset
      +stream.ping
    }

    class ClawboardDB {
      +Space
      +Topic
      +Task
      +LogEntry
      +DeletedLog
      +SessionRoutingMemory
      +IngestQueue
      +Attachment
      +Draft
      +InstanceConfig
    }

    class ClassifierWorker {
      +process_reindex_queue()
      +acquire_lock()
      +classify_session()
      +call_classifier()
      +call_creation_gate()
      +call_summary_repair()
      +classify_without_llm()
    }

    class EmbeddingStore {
      +Qdrant-backed vectors
      +dense optional at query-time
      +upsert/delete/topk
    }

    class OpenClawGatewayWS {
      +gateway_rpc()
      +chat.send
      +skills.status
    }

    class OpenClawLLMAPI {
      +chat_completions_v1()
      +strict_json_output()
      +repair_pass()
    }

    class ClawboardUI {
      +BoardChatComposer
      +DataProvider
      +UnifiedView
      +useSemanticSearch
      +useLiveUpdates
    }

    OpenClawRuntime --> ClawboardLoggerPlugin : hook events
    ClawboardLoggerPlugin --> ClawboardAPI : /api/log or /api/ingest
    ClawboardAPI --> ClawboardDB : persistence + idempotency
    ClawboardAPI --> EventHubSSE : publish live events
    EventHubSSE --> ClawboardUI : SSE stream
    ClawboardUI --> ClawboardAPI : /api/changes + /api/search + /api/context
    ClassifierWorker --> ClawboardAPI : pending/read/patch/session-routing
    ClassifierWorker --> EmbeddingStore : candidate retrieval + reindex
    ClawboardAPI --> OpenClawGatewayWS : openclaw chat dispatch
    ClawboardAPI --> OpenClawLLMAPI : gateway-backed chat completion
    ClassifierWorker --> OpenClawLLMAPI : classify + gate + summary repair
```

## 2) Offworld Ingestion + Classification Sequence

```mermaid
sequenceDiagram
    autonumber
    participant U as User or External Channel
    participant OC as OpenClaw Runtime
    participant PL as clawboard-logger plugin
    participant API as Clawboard API
    participant DB as Clawboard DB
    participant EV as EventHub SSE
    participant CL as Classifier Worker
    participant ES as Embedding Store
    participant LLM as OpenClaw LLM API
    participant UI as Clawboard UI

    U->>OC: inbound or outbound conversation/tool activity
    OC->>PL: message_received/message_sending/before_tool_call/after_tool_call/agent_end
    PL->>PL: sanitize text, strip injected context, drop classifier payload noise
    PL->>PL: compute effective sessionKey and board scope
    alt ignored session prefix
        PL-->>OC: skip logging
    else accepted
        PL->>API: POST /api/log (or /api/ingest) with idempotency key
        API->>DB: append_log_entry()
        API->>DB: idempotency dedupe + scope normalization + task/topic consistency
        alt source.channel == cron-event
            API->>DB: classificationStatus=failed, classificationError=filtered_cron_event
        end
        API->>EV: publish log.appended
        EV-->>UI: SSE log.appended
    end

    loop classifier cycle
        CL->>CL: process_reindex_queue() and single-flight lock
        CL->>API: GET /api/classifier/pending
        API-->>CL: pending conversation logs
        CL->>CL: group by source.sessionKey and prioritize sessions
        CL->>API: list session lookback logs
        CL->>CL: filter non-semantic context, choose one bundle via _bundle_range()
        CL->>CL: build scope_logs and retrieval text

        alt board task scope sessionKey clawboard:task:...
            CL->>API: PATCH scope logs to fixed topicId+taskId
        else normal or topic-pinned flow
            CL->>API: GET /api/classifier/session-routing (ambiguous follow-ups)
            CL->>ES: topic_candidates() and task_candidates()
            alt LLM path enabled
                CL->>LLM: call_classifier() with strict outputTemplate JSON
                alt malformed JSON
                    CL->>LLM: deterministic repair call
                end
                CL->>LLM: optional creation gate and summary repair
            else fallback path
                CL->>CL: classify_without_llm()
            end
            CL->>API: PATCH scope logs with topicId/taskId/summary/classificationStatus
            CL->>API: POST /api/classifier/session-routing append decision
        end
    end

    API->>EV: publish log.patched
    EV-->>UI: SSE log.patched
```

## 3) Board Chat Send/Return Sequence

```mermaid
sequenceDiagram
    autonumber
    participant UI as Clawboard UI (BoardChatComposer)
    participant API as Clawboard API
    participant DB as Clawboard DB + attachments storage
    participant DQ as Durable dispatch queue/workers
    participant GW as OpenClaw Gateway WS RPC
    participant OC as OpenClaw Runtime
    participant PL as clawboard-logger plugin
    participant EV as EventHub SSE
    participant WD as Assistant-log watchdog

    opt attachments
        UI->>API: POST /api/attachments
        API->>DB: store file metadata + bytes
        API-->>UI: attachment ids
    end

    UI->>API: POST /api/openclaw/chat (sessionKey, message, attachmentIds)
    API->>DB: persist user conversation log immediately
    API->>EV: publish openclaw.typing true + openclaw.thread_work active
    API-->>UI: queued=true, requestId
    API->>DQ: enqueue requestId/sessionKey/message
    DQ->>GW: chat.send(idempotencyKey=requestId)
    GW->>OC: dispatch user message

    OC->>PL: assistant conversation/tool hooks
    PL->>API: POST /api/log assistant/action rows
    API->>DB: persist rows and patch typing false on assistant logs
    API->>EV: log.appended/log.patched/openclaw.typing false/openclaw.thread_work inactive
    EV-->>UI: live updates

    opt user cancels selected thread
        UI->>API: DELETE /api/openclaw/chat (sessionKey, requestId?)
        API->>EV: publish openclaw.typing false + openclaw.thread_work inactive
        API->>DQ: mark matching queue rows failed(user_cancelled)
        API->>GW: chat.abort on parent + linked child sessions (when lineage resolves)
        API-->>UI: aborted/queueCancelled/sessionKeys
    end

    API->>WD: schedule requestId/sessionKey watchdog
    loop poll interval while run is active
        WD->>API: check for assistant output and non-user activity
    end
    Note over API,WD: On API restart, watchdog recovers unresolved requestIds from persisted user logs.
    Note over DQ: worker retry/backoff + stale-processing recovery + optional auto-quarantine
    alt no assistant output after inactivity window
        WD->>API: append system warning log
        API->>DB: persist warning
        API->>EV: publish log.appended(system warning)
    end
```

## 4) Context Injection + Search Sequence

```mermaid
sequenceDiagram
    autonumber
    participant OC as OpenClaw Runtime
    participant PL as clawboard-logger before_agent_start
    participant API as Clawboard API
    participant DB as Clawboard DB
    participant SRCH as Search pipeline (_search_impl + semantic_search)

    OC->>PL: before_agent_start(prompt, messages)
    PL->>PL: latestUserInput() + sanitizeMessageContent()
    PL->>API: GET /api/context(q, sessionKey, mode, includePending)
    API->>DB: Layer A board session + working set + routing memory + timeline
    opt semantic layer enabled by mode/query signal
        API->>SRCH: _search_impl(...)
        SRCH->>DB: bounded topic/task/log windows + snippet scans
        SRCH-->>API: hybrid ranked topics/tasks/logs/notes
    end
    API-->>PL: prompt-ready context block
    PL->>OC: prepend [CLAWBOARD_CONTEXT_BEGIN ... END]
```

## 5) Classifier Decision State Machine (Per Bundle)

```mermaid
stateDiagram-v2
    [*] --> LoadSessionContext
    LoadSessionContext --> CleanupOnly : no pending conversations
    LoadSessionContext --> BuildBundle : pending conversations exist

    CleanupOnly --> PatchFilteredOnly
    PatchFilteredOnly --> [*]

    BuildBundle --> ForcedTaskScope : sessionKey clawboard:task:...
    BuildBundle --> ForcedTopicScope : sessionKey clawboard:topic:...
    BuildBundle --> NormalScope : all other sessions

    ForcedTaskScope --> PatchScope
    ForcedTopicScope --> CandidateRetrieval
    NormalScope --> CandidateRetrieval

    CandidateRetrieval --> SmallTalkFastPath : small-talk bundle
    SmallTalkFastPath --> PatchScope

    CandidateRetrieval --> LLMRouting : LLM enabled
    CandidateRetrieval --> HeuristicRouting : LLM disabled or failed
    LLMRouting --> Guardrails
    HeuristicRouting --> Guardrails

    Guardrails --> TaskDecision
    TaskDecision --> SummaryResolution
    SummaryResolution --> PatchScope
    PatchScope --> PersistSessionRoutingMemory
    PersistSessionRoutingMemory --> [*]

    state PatchScope {
      [*] --> PendingRow
      PendingRow --> ClassifiedSemantic : normal semantic row
      PendingRow --> ClassifiedFiltered : filtered_command or filtered_non_semantic or filtered_memory_action or filtered_tool_activity
      PendingRow --> FailedFiltered : filtered_cron_event or filtered_control_plane or filtered_subagent_scaffold or filtered_unanchored_tool_activity or noise code
      ClassifiedSemantic --> [*]
      ClassifiedFiltered --> [*]
      FailedFiltered --> [*]
    }
```

## 6) Persistence Model (UML Class Diagram)

```mermaid
classDiagram
    class Space {
      +id: str
      +name: str
      +defaultVisible: bool
      +connectivity: json
      +createdAt: iso
      +updatedAt: iso
    }

    class Topic {
      +id: str
      +spaceId: str
      +name: str
      +status: enum_active_snoozed_archived
      +priority: enum_low_medium_high
      +digest: optional
      +createdAt: iso
      +updatedAt: iso
    }

    class Task {
      +id: str
      +spaceId: str
      +topicId: nullable_str
      +title: str
      +status: enum_todo_doing_blocked_done
      +priority: enum_low_medium_high
      +digest: optional
      +createdAt: iso
      +updatedAt: iso
    }

    class LogEntry {
      +id: str
      +spaceId: str
      +topicId: nullable_str
      +taskId: nullable_str
      +type: enum_conversation_action_note_system_import
      +content: str
      +summary: nullable_str
      +raw: nullable_str
      +classificationStatus: enum_pending_classified_failed
      +classificationAttempts: int
      +classificationError: nullable_str
      +source: json
      +attachments: nullable_json
      +idempotencyKey: nullable_str
      +createdAt: iso
      +updatedAt: iso
    }

    class DeletedLog {
      +id: str
      +deletedAt: iso
    }

    class SessionRoutingMemory {
      +sessionKey: str
      +items: json array
      +createdAt: iso
      +updatedAt: iso
    }

    class IngestQueue {
      +id: int
      +payload: json
      +status: enum_pending_processing_failed_done
      +attempts: int
      +lastError: nullable_str
      +createdAt: iso
    }

    class Attachment {
      +id: str
      +logId: nullable_str
      +fileName: str
      +mimeType: str
      +sizeBytes: int
      +sha256: str
      +storagePath: str
      +createdAt: iso
      +updatedAt: iso
    }

    class Draft {
      +key: str
      +value: str
      +createdAt: iso
      +updatedAt: iso
    }

    class InstanceConfig {
      +id: singleton
      +title: str
      +integrationLevel: enum_manual_write_full
      +updatedAt: iso
    }

    Space "1" --> "0..*" Topic : owns
    Space "1" --> "0..*" Task : owns
    Space "1" --> "0..*" LogEntry : owns
    Topic "1" --> "0..*" Task : parent
    Topic "0..1" --> "0..*" LogEntry : routed_to
    Task "0..1" --> "0..*" LogEntry : routed_to
    LogEntry "1" --> "0..*" Attachment : has
    LogEntry "0..1" --> "0..*" DeletedLog : tombstone_on_delete
    SessionRoutingMemory ..> LogEntry : logical by source.sessionKey
    IngestQueue ..> LogEntry : async ingestion source
```
