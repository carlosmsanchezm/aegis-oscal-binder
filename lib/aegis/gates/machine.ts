import { initialTransition, setup, transition, assign } from "xstate";
import type { GateState, WorkflowEvent, WorkflowState } from "./types";

export type GateMode = "quorum" | "external" | "outside" | "closure";

export type GateMachineContext = {
  mode: GateMode;
  requiredSlots: string[];
  receivedSlots: string[];
  authorizationGranted: false;
  citation: string;
};

export type GateMachineEvent =
  | { type: "REQUEST" }
  | { type: "APPROVE"; slot: string }
  | { type: "DENY" }
  | { type: "WITHDRAW" }
  | { type: "SUBMIT" }
  | { type: "CITE"; reference: string };

function gateMachine(initial: GateState) {
  return setup({
    types: {
      context: {} as GateMachineContext,
      events: {} as GateMachineEvent,
      input: {} as GateMachineContext,
    },
    guards: {
      isQuorum: ({ context }) => context.mode === "quorum",
      isClosure: ({ context }) => context.mode === "closure",
      isCite: ({ context }) => context.mode === "external" || context.mode === "outside",
      quorumMet: ({ context, event }) => {
        if (event.type !== "APPROVE") return false;
        const next = context.receivedSlots.includes(event.slot) ? context.receivedSlots : [...context.receivedSlots, event.slot];
        return context.requiredSlots.every((slot) => next.includes(slot));
      },
    },
    actions: {
      addSlot: assign({
        receivedSlots: ({ context, event }) => {
          if (event.type !== "APPROVE" || context.receivedSlots.includes(event.slot)) return context.receivedSlots;
          return [...context.receivedSlots, event.slot];
        },
        authorizationGranted: () => false as const,
      }),
      clearSlots: assign({
        receivedSlots: () => [],
        authorizationGranted: () => false as const,
      }),
      cite: assign({
        citation: ({ event }) => (event.type === "CITE" ? event.reference : ""),
        authorizationGranted: () => false as const,
      }),
    },
  }).createMachine({
    id: "human-gate",
    initial,
    context: ({ input }) => ({
      mode: input.mode,
      requiredSlots: [...input.requiredSlots],
      receivedSlots: [...input.receivedSlots],
      authorizationGranted: false,
      citation: input.citation,
    }),
    states: {
      idle: {
        on: {
          REQUEST: { target: "pending", guard: "isQuorum" },
          SUBMIT: { target: "submitted", guard: "isClosure" },
          CITE: { target: "recorded-externally", guard: "isCite", actions: "cite" },
        },
      },
      pending: {
        on: {
          APPROVE: [
            { guard: "quorumMet", target: "approved", actions: "addSlot" },
            { guard: "isQuorum", actions: "addSlot" },
          ],
          DENY: { target: "denied", actions: "clearSlots" },
          WITHDRAW: { target: "withdrawn", actions: "clearSlots" },
        },
      },
      denied: {
        on: { REQUEST: { target: "pending", guard: "isQuorum", actions: "clearSlots" } },
      },
      withdrawn: {
        on: { REQUEST: { target: "pending", guard: "isQuorum", actions: "clearSlots" } },
      },
      submitted: {
        on: { CITE: { target: "recorded-externally", guard: "isClosure", actions: "cite" } },
      },
      approved: {},
      "recorded-externally": {},
    },
  });
}

function snapshotContext(value: unknown): GateMachineContext {
  const context = value as GateMachineContext;
  return {
    mode: context.mode,
    requiredSlots: [...context.requiredSlots],
    receivedSlots: [...context.receivedSlots],
    authorizationGranted: false,
    citation: context.citation,
  };
}

export function previewGate(state: GateState, context: GateMachineContext, event: GateMachineEvent): { state: GateState; context: GateMachineContext } | null {
  const machine = gateMachine(state);
  const [current] = initialTransition(machine, context);
  const [next] = transition(machine, current, event);
  const nextContext = snapshotContext(next.context);
  const nextState = String(next.value) as GateState;
  const same = nextState === state && JSON.stringify(nextContext) === JSON.stringify(snapshotContext(current.context));
  if (same) return null;
  return { state: nextState, context: nextContext };
}

const WORKFLOW_STATES: Record<WorkflowState, { on?: Partial<Record<WorkflowEvent, WorkflowState>> }> = {
  planned: { on: { VALIDATE_FINDING: "finding-validated" } },
  "finding-validated": { on: { APPROVE_PLAN: "plan-approved" } },
  "plan-approved": { on: { LAUNCH: "agent-running" } },
  "agent-running": { on: { PROPOSE: "proposed" } },
  proposed: { on: { APPROVE_MERGE: "merge-approved" } },
  "merge-approved": { on: { APPROVE_DEPLOY: "deployed", REOPEN: "reopened" } },
  deployed: { on: { RESCAN: "rescan-pending", REOPEN: "reopened" } },
  "rescan-pending": { on: { READY: "ready-for-closure-review", REOPEN: "reopened" } },
  "ready-for-closure-review": { on: { CLOSE_EXTERNAL: "closed-externally", REOPEN: "reopened" } },
  "closed-externally": { on: { REOPEN: "reopened" } },
  reopened: { on: { PROPOSE: "proposed", RESCAN: "rescan-pending" } },
};

function workflowMachine(initial: WorkflowState) {
  return setup({
    types: { events: {} as { type: WorkflowEvent } },
  }).createMachine({
    id: "poam-workflow",
    initial,
    states: WORKFLOW_STATES,
  });
}

/** Legal item transition. XState is the graph; the stored value is the state name. */
export function previewWorkflow(state: WorkflowState, event: WorkflowEvent): WorkflowState | null {
  const machine = workflowMachine(state);
  const [current] = initialTransition(machine);
  const [next] = transition(machine, current, { type: event });
  const value = String(next.value) as WorkflowState;
  return value === state ? null : value;
}
