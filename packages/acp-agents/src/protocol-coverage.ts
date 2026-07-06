import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";

type ValueOf<T> = T[keyof T];
type ClientMethod = ValueOf<typeof CLIENT_METHODS>;
type AgentMethod = ValueOf<typeof AGENT_METHODS>;

export type ClientMethodCoverage = "served" | "pending";
/** `guarded` means the raw passthrough would create/reopen session state outside the router, so
 *  the client rejects it until a driven wrapper can route updates, permissions, and terminals. */
export type AgentMethodCoverage = "driven" | "passthrough" | "guarded";

/** Enforceable definition of "full ACP spec support": every SDK method constant is classified
 *  here, and the tripwire test fails when an SDK bump silently widens or shrinks the protocol. */
export const CLIENT_METHOD_COVERAGE: Record<ClientMethod, ClientMethodCoverage> = {
  [CLIENT_METHODS.session_request_permission]: "served",
  [CLIENT_METHODS.session_update]: "served",
  [CLIENT_METHODS.fs_read_text_file]: "served",
  [CLIENT_METHODS.fs_write_text_file]: "served",
  [CLIENT_METHODS.terminal_create]: "served",
  [CLIENT_METHODS.terminal_output]: "served",
  [CLIENT_METHODS.terminal_release]: "served",
  [CLIENT_METHODS.terminal_wait_for_exit]: "served",
  [CLIENT_METHODS.terminal_kill]: "served",
  [CLIENT_METHODS.mcp_connect]: "pending",
  [CLIENT_METHODS.mcp_message]: "pending",
  [CLIENT_METHODS.mcp_disconnect]: "pending",
  [CLIENT_METHODS.elicitation_create]: "pending",
  [CLIENT_METHODS.elicitation_complete]: "pending",
};

export const AGENT_METHOD_COVERAGE: Record<AgentMethod, AgentMethodCoverage> = {
  [AGENT_METHODS.initialize]: "driven",
  [AGENT_METHODS.authenticate]: "passthrough",
  [AGENT_METHODS.providers_list]: "passthrough",
  [AGENT_METHODS.providers_set]: "passthrough",
  [AGENT_METHODS.providers_disable]: "passthrough",
  [AGENT_METHODS.session_new]: "driven",
  [AGENT_METHODS.session_load]: "driven",
  [AGENT_METHODS.session_set_mode]: "driven",
  [AGENT_METHODS.session_set_config_option]: "driven",
  [AGENT_METHODS.session_prompt]: "driven",
  [AGENT_METHODS.session_cancel]: "driven",
  [AGENT_METHODS.mcp_message]: "passthrough",
  [AGENT_METHODS.session_list]: "driven",
  [AGENT_METHODS.session_delete]: "driven",
  [AGENT_METHODS.session_fork]: "guarded",
  [AGENT_METHODS.session_resume]: "driven",
  [AGENT_METHODS.session_close]: "driven",
  [AGENT_METHODS.logout]: "passthrough",
  [AGENT_METHODS.nes_start]: "passthrough",
  [AGENT_METHODS.nes_suggest]: "passthrough",
  [AGENT_METHODS.nes_accept]: "passthrough",
  [AGENT_METHODS.nes_reject]: "passthrough",
  [AGENT_METHODS.nes_close]: "passthrough",
  [AGENT_METHODS.document_did_open]: "passthrough",
  [AGENT_METHODS.document_did_change]: "passthrough",
  [AGENT_METHODS.document_did_close]: "passthrough",
  [AGENT_METHODS.document_did_save]: "passthrough",
  [AGENT_METHODS.document_did_focus]: "passthrough",
};
