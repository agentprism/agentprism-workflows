import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useRef, useState } from "react";
import type { NodeModel } from "./state.js";
import { resultError } from "./run-status.js";
import type { RunStatusSnapshot } from "./run-status.js";

/** Locks synchronously against double clicks and ignores late replies after a panel/run replacement. */
function useCommand(app: App, onRefresh: () => void) {
  const active = useRef(true);
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const execute = async (args: Record<string, unknown>) => {
    if (lock.current || !active.current) return;
    lock.current = true;
    setPending(true);
    setFeedback(undefined);
    try {
      const result = await app.callServerTool({
        name: "workflow",
        arguments: args,
      });
      if (!active.current) return;
      resultError(result);
      setFeedback({
        error: false,
        text: "Response accepted. Refreshing current state…",
      });
      onRefresh();
    } catch (error) {
      if (active.current) {
        setFeedback({
          error: true,
          text:
            error instanceof Error
              ? error.message
              : "This action failed. Refresh the run and try again.",
        });
        onRefresh();
      }
    } finally {
      lock.current = false;
      if (active.current) setPending(false);
    }
  };
  return { execute, pending, feedback };
}

function Feedback({
  value,
}: {
  value: { error: boolean; text: string } | undefined;
}) {
  return value ? (
    <p
      className={
        value.error ? "action-feedback action-error" : "action-feedback"
      }
      role={value.error ? "alert" : "status"}
    >
      {value.text}
    </p>
  ) : null;
}

export function StopButton({
  app,
  runId,
  callIndex,
  onRefresh,
}: {
  app: App;
  runId: string;
  callIndex?: number;
  onRefresh: () => void;
}) {
  const command = useCommand(app, onRefresh);
  return (
    <span className="stop-control">
      <button
        className="stop-btn"
        disabled={command.pending}
        onClick={() =>
          void command.execute({
            action: "stop",
            runId,
            ...(callIndex === undefined ? {} : { callIndex }),
          })
        }
      >
        {command.pending
          ? "Stopping…"
          : callIndex === undefined
          ? "Stop run"
          : "Stop this agent"}
      </button>
      <Feedback value={command.feedback} />
    </span>
  );
}

function SetupForm({
  app,
  snapshot,
  onRefresh,
}: {
  app: App;
  snapshot: RunStatusSnapshot;
  onRefresh: () => void;
}) {
  const request = snapshot.setup?.request;
  const [content, setContent] = useState<Record<string, unknown>>({});
  const command = useCommand(app, onRefresh);
  if (!request) return null;
  const properties = Object.entries(request.requestedSchema.properties);
  const unsupported = properties.some(([, raw]) => {
    const field = raw as Record<string, unknown>;
    return (
      field.type !== "boolean" &&
      !(field.type === "string" && Array.isArray(field.oneOf))
    );
  });
  const complete =
    !unsupported &&
    request.requestedSchema.required.every((name) =>
      Object.hasOwn(content, name),
    );
  return (
    <form
      className="action-section"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete)
          void command.execute({
            action: "setup-response",
            runId: snapshot.runId,
            setupId: request.id,
            response: { action: "accept", content },
          });
      }}
    >
      <h2>{request.title}</h2>
      <p>{request.message}</p>
      {properties.map(([name, raw]) => {
        const field = raw as {
          type?: string;
          title?: string;
          description?: string;
          oneOf?: Array<{ const: string; title?: string }>;
        };
        return (
          <label className="setup-field" key={name}>
            <span>{field.title ?? name}</span>
            {field.description && <small>{field.description}</small>}
            {field.type === "boolean" ? (
              <select
                aria-label={field.title ?? name}
                value={content[name] === undefined ? "" : String(content[name])}
                disabled={command.pending}
                onChange={(event) =>
                  setContent((current) => ({
                    ...current,
                    [name]: event.target.value === "true",
                  }))
                }
              >
                <option value="" disabled>
                  Choose an answer
                </option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : field.type === "string" && field.oneOf ? (
              <select
                aria-label={field.title ?? name}
                value={
                  typeof content[name] === "string"
                    ? (content[name] as string)
                    : ""
                }
                disabled={command.pending}
                onChange={(event) =>
                  setContent((current) => ({
                    ...current,
                    [name]: event.target.value,
                  }))
                }
              >
                <option value="" disabled>
                  Choose an option
                </option>
                {field.oneOf.map((option) => (
                  <option key={option.const} value={option.const}>
                    {option.title ?? option.const}
                  </option>
                ))}
              </select>
            ) : (
              <span>Use the workflow setup-response tool for this field.</span>
            )}
          </label>
        );
      })}
      <div className="action-buttons">
        <button disabled={command.pending || !complete} type="submit">
          {command.pending ? "Sending…" : "Submit setup"}
        </button>
        <button
          disabled={command.pending}
          type="button"
          onClick={() =>
            void command.execute({
              action: "setup-response",
              runId: snapshot.runId,
              setupId: request.id,
              response: { action: "decline" },
            })
          }
        >
          Decline setup
        </button>
      </div>
      <Feedback value={command.feedback} />
    </form>
  );
}

function CheckpointForm({
  app,
  snapshot,
  onRefresh,
}: {
  app: App;
  snapshot: RunStatusSnapshot;
  onRefresh: () => void;
}) {
  const checkpoint = snapshot.checkpointContext!;
  const [answer, setAnswer] = useState<string | undefined>();
  const command = useCommand(app, onRefresh);
  const submit = (decision: unknown) => {
    void command.execute({
      action: "resume",
      runId: snapshot.runId,
      checkpointReplies: { [checkpoint.callIndex]: decision },
    });
  };
  return (
    <form
      className="action-section"
      onSubmit={(event) => {
        event.preventDefault();
        if (answer !== undefined) submit(answer);
      }}
    >
      <h2>Checkpoint {checkpoint.callIndex}</h2>
      <p>{checkpoint.prompt}</p>
      {checkpoint.kind === "confirm" ? (
        <div className="action-buttons">
          <button
            type="button"
            disabled={command.pending}
            onClick={() => submit(true)}
          >
            Yes, continue
          </button>
          <button
            type="button"
            disabled={command.pending}
            onClick={() => submit(false)}
          >
            No
          </button>
        </div>
      ) : (
        <>
          {checkpoint.kind === "select" ? (
            <select
              aria-label="Checkpoint answer"
              value={answer ?? ""}
              disabled={command.pending}
              onChange={(event) => setAnswer(event.target.value)}
            >
              <option value="" disabled>
                Choose an answer
              </option>
              {checkpoint.choices?.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          ) : (
            <textarea
              aria-label="Checkpoint answer"
              value={answer ?? ""}
              disabled={command.pending}
              onChange={(event) => setAnswer(event.target.value)}
            />
          )}
          <button
            type="submit"
            disabled={command.pending || answer === undefined}
          >
            {command.pending ? "Sending…" : "Answer and resume"}
          </button>
        </>
      )}
      <Feedback value={command.feedback} />
    </form>
  );
}

function PermissionForm({
  app,
  request,
  onRefresh,
}: {
  app: App;
  request: NonNullable<RunStatusSnapshot["pendingPermissions"]>[number];
  onRefresh: () => void;
}) {
  const command = useCommand(app, onRefresh);
  return (
    <section className="action-section">
      <h2>Permission · {request.label ?? `Agent ${request.callIndex}`}</h2>
      <p>
        {typeof request.request.toolCall.title === "string"
          ? request.request.toolCall.title
          : `Tool request from ${request.backendId}`}
      </p>
      <details>
        <summary>Request details</summary>
        <pre>{JSON.stringify(request.request.toolCall, null, 2)}</pre>
      </details>
      <div className="action-buttons">
        {request.request.options.map((option) => (
          <button
            key={option.optionId}
            disabled={command.pending}
            onClick={() =>
              void command.execute({
                action: "permissions-response",
                runId: request.runId,
                permissionId: request.permissionId,
                response: { outcome: "selected", optionId: option.optionId },
              })
            }
          >
            {option.name}
            <small>{option.kind.replaceAll("_", " ")}</small>
          </button>
        ))}
        <button
          disabled={command.pending}
          onClick={() =>
            void command.execute({
              action: "permissions-response",
              runId: request.runId,
              permissionId: request.permissionId,
              response: { outcome: "cancelled" },
            })
          }
        >
          Cancel request
        </button>
      </div>
      <Feedback value={command.feedback} />
    </section>
  );
}

interface ResultPage {
  runId: string;
  offset: number;
  endOffset: number;
  totalBytes: number;
  hasMore: boolean;
  chunk: string;
}

function ExactResult({ app, runId }: { app: App; runId: string }) {
  const [page, setPage] = useState<ResultPage>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const active = useRef(true);
  const lock = useRef(false);
  const previousOffsets = useRef<number[]>([]);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  const read = async (
    offset: number,
    direction: "next" | "previous" | "first",
  ) => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(undefined);
    setCopied(false);
    try {
      const result = await app.callServerTool({
        name: "workflow",
        arguments: { action: "result", runId, offset, maxBytes: 16_384 },
      });
      if (!active.current) return;
      resultError(result);
      const next = result.structuredContent as unknown as ResultPage;
      if (
        next.runId !== runId ||
        next.offset !== offset ||
        typeof next.chunk !== "string" ||
        next.endOffset < offset ||
        (next.hasMore && next.endOffset === offset)
      )
        throw new Error("The server returned an invalid exact-result page.");
      if (direction === "next" && page)
        previousOffsets.current.push(page.offset);
      if (direction === "previous") previousOffsets.current.pop();
      setPage(next);
    } catch (failure) {
      if (active.current)
        setError(
          failure instanceof Error ? failure.message : "Result read failed.",
        );
    } finally {
      lock.current = false;
      if (active.current) setPending(false);
    }
  };
  return (
    <section className="action-section exact-result">
      <h2>Completed result</h2>
      {!page ? (
        <button disabled={pending} onClick={() => void read(0, "first")}>
          {pending ? "Loading…" : "Inspect exact result"}
        </button>
      ) : (
        <>
          <p>
            Bytes {page.offset}–{page.endOffset} of {page.totalBytes}
          </p>
          <pre tabIndex={0} aria-label="Exact result">
            {page.chunk}
          </pre>
          <div className="action-buttons">
            <button
              disabled={pending || previousOffsets.current.length === 0}
              onClick={() =>
                void read(previousOffsets.current.at(-1)!, "previous")
              }
            >
              Previous page
            </button>
            <button
              disabled={pending || !page.hasMore}
              onClick={() => void read(page.endOffset, "next")}
            >
              Next page
            </button>
            <button
              onClick={() =>
                void Promise.resolve()
                  .then(() => {
                    if (!navigator.clipboard?.writeText)
                      throw new Error("Clipboard unavailable");
                    return navigator.clipboard.writeText(page.chunk);
                  })
                  .then(() => {
                    if (active.current) setCopied(true);
                  })
                  .catch(() => {
                    if (active.current)
                      setError(
                        "Clipboard access was rejected. Select the result text to copy it.",
                      );
                  })
              }
            >
              {copied
                ? "Copied"
                : page.offset === 0 && !page.hasMore
                ? "Copy result"
                : "Copy this page"}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="action-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function RunActions({
  app,
  snapshot,
  selected,
  onRefresh,
}: {
  app: App;
  snapshot: RunStatusSnapshot | undefined;
  selected: NodeModel | undefined;
  onRefresh: () => void;
}) {
  if (!snapshot) return null;
  return (
    <div className="run-actions">
      {snapshot.setup?.state === "preparing" && (
        <section className="action-section">
          <h2>Preparing workflow</h2>
          <p>
            Validating the accepted source and checking backend configuration.
          </p>
        </section>
      )}
      {snapshot.setup?.request && (
        <SetupForm
          key={snapshot.setup.request.id}
          app={app}
          snapshot={snapshot}
          onRefresh={onRefresh}
        />
      )}
      {snapshot.pendingPermissions
        ?.filter((request) => request.runId === snapshot.runId)
        .map((request) => (
          <PermissionForm
            key={request.permissionId}
            app={app}
            request={request}
            onRefresh={onRefresh}
          />
        ))}
      {snapshot.status === "paused" && snapshot.checkpointContext && (
        <CheckpointForm
          key={`${snapshot.checkpointContext.callIndex}:${snapshot.checkpointContext.hash}`}
          app={app}
          snapshot={snapshot}
          onRefresh={onRefresh}
        />
      )}
      {snapshot.status === "paused" &&
        !snapshot.checkpointContext &&
        snapshot.pauseReason && (
          <section className="action-section">
            <h2>Run needs attention</h2>
            <p>
              {snapshot.pauseReason === "auth_required"
                ? `Authenticate ${
                    snapshot.authContext?.backendId ?? "the backend"
                  } on this machine, then resume through the workflow tool.`
                : `The run is paused: ${snapshot.pauseReason}. Inspect status before continuing.`}
            </p>
          </section>
        )}
      {selected?.status === "running" &&
        (!selected.scope || selected.scope === snapshot.runId) &&
        snapshot.status === "running" && (
          <div className="action-section">
            <StopButton
              app={app}
              runId={snapshot.runId}
              callIndex={selected.callIndex}
              onRefresh={onRefresh}
            />
          </div>
        )}
      {snapshot.status === "completed" && (
        <ExactResult app={app} runId={snapshot.runId} />
      )}
    </div>
  );
}
