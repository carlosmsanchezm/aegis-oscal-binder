import { HONESTY } from "@/lib/m1/copy";
import type { Role } from "./types";
import { roleLabel } from "./text";

export { HONESTY };

export const NOT_BUILT = "Not built";

export const SIGN_IN = {
  caption: "Sign in",
  title: "Sign in with your work account",
  body: "Use the Google or Microsoft work account your organization admin invited. Personal accounts are not accepted.",
  google: "Continue with Google work account",
  microsoft: "Continue with Microsoft work account",
  waiting: (provider: string) => `Waiting for ${provider}…`,
  cancel: "Cancel",
  failed: "Sign in did not finish. It was cancelled, or the sign in service returned an error. Nothing was saved. Try again.",
  personal: "Personal accounts are not accepted. Use the Google or Microsoft work account your organization invited.",
  unverified: "That work account did not confirm its email address. Nothing was saved.",
  configuration: "Google and Microsoft sign-in need an OAuth app registration and AUTH_SECRET on this deployment. Until those are set, these buttons cannot finish sign-in.",
  configurationProviders: "AUTH_SECRET is set. Google and Microsoft sign-in still need an OAuth app registration on this deployment. Until a provider app is registered, these buttons cannot finish sign-in.",
  hosted: "Sign in runs on a hosted sign in service. OSCAL binder never sees your password.",
  noOrg: "Ask your organization admin to invite this exact address, then sign in again.",
  createOrg: "Or start an organization",
  createOrgNote: "You become the admin. Use this when nobody has invited this address.",
  expiredTitle: "Session expired",
  expired: "Sign in again to continue. Your session ended. Saved plans, evidence and exports are unchanged. Text typed into an open form and not saved is not kept.",
  welcome: "Welcome back",
  welcomeBody: "You are signed in. Taking you to where you left off.",
  go: "Go now",
  signOut: "Sign out",
  alpha: "Alpha test build. Not FedRAMP authorized and not an ATO.",
} as const;

export function storageSentence(mode: "blob" | "directory" | "unset"): string {
  if (mode === "blob") return "Files you upload are stored in the private hosted store configured for this deployment. Whether that store stays hosted or moves to a directory you run is not decided.";
  if (mode === "directory") return "Files you upload are stored in the directory configured for this deployment. Whether that store stays a directory or moves to a hosted store is not decided.";
  return "No durable store is configured for this deployment, so uploads cannot be kept. Hosted or directory storage is not decided.";
}

export const DATA_HANDLING = [
  "OSCAL binder is an alpha test build. This alpha is not approved for agency data.",
  "Upload only files your organization has approved for this test, such as synthetic, public, or approved test data. If you are not sure a file is approved, do not upload it.",
] as const;

export const NOT_BUILT_ITEMS = [
  "Invitation email. The invitation link works. Mail is not sent.",
  "Workspace rename",
  "Workspace delete",
  "Feedback mail",
  "Alpha agreement document",
] as const;

export function roleLimit(role: Role): string {
  const label = roleLabel(role);
  if (role === "admin") return `Your role is ${label}. You can invite members, change roles, and change a claimed workspace boundary.`;
  if (role === "isso" || role === "system-owner") return `Your role is ${label}. You can create a workspace and change a claimed boundary. You cannot invite members or change roles.`;
  if (role === "engineer") return `Your role is ${label}. You can change a claimed workspace boundary. You cannot invite members or change roles.`;
  if (role === "isse") return `Your role is ${label}. You can review findings and SSP text on a gate. You cannot invite members, change roles, or change the boundary.`;
  if (role === "release-manager") return `Your role is ${label}. You can approve promotion. Release approval is not an authorization decision. You cannot invite members, change roles, or change the boundary.`;
  return `Your role is ${label}. You can read a claimed workspace boundary. You cannot invite members, change roles, or change the boundary.`;
}
