// The organisation's own mail identity: its email domain, the mail sources the
// hourly check searches, and mailboxes that are never read. These are company
// details, so they live in private config (config.org), never in this public
// repo. useOrg(config.org) is called before a board is built or a mail check
// is saved; tests set their own made-up values.
const state = { domain: "", sources: [], neverRead: [] };

export function useOrg(org = {}) {
  state.domain = String(org?.domain || "").toLowerCase();
  state.sources = [...(org?.mailSources || [])];
  state.neverRead = (org?.neverRead || []).map((address) => String(address).toLowerCase());
}
export const ownDomain = () => state.domain;
export const mailSources = () => state.sources;
export const isOwnAddress = (address) => Boolean(state.domain) && String(address || "").toLowerCase().endsWith(`@${state.domain}`);
export const isNeverRead = (mailbox) => state.neverRead.includes(String(mailbox || "").toLowerCase());
