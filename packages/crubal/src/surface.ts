// surface.ts: the lines that grant or withhold a surface (14.14, revision 43). A surface is a tree of addresses,
// each a path of names; what stands on it (a utility's chains and lanes, a chain's links, their presses) is the
// reader's to build from what its packages carry, since a lane and a flow are no words of the vocabulary
// (revision 67). A line says see or run of an address, yes or no; the deepest line on the way to an address
// decides, and a no beats a yes at the same depth. Pure: no store, no caller. Who holds which lines is the
// edge's (access.ts).

import { CrubalError } from "./tree.ts";

export const SURFACE_VERBS = ["see", "run"] as const;
export type SurfaceVerb = (typeof SURFACE_VERBS)[number];
export type SurfaceLine = { no?: true; verb: SurfaceVerb; address: string };
export type SurfaceAnswer = "yes" | "no" | undefined;

type Serves = { as: string; items?: string[]; line: number }[];
export type SurfaceNode = {
  address: string;
  sort: "utility" | "chain" | "link" | "lane" | "press" | "case";
  /** The name the package gave it: a utility's, a flow's, a stop's, a lane's, a press's word. */
  name: string;
  label?: string;
  /** What the package says it serves, where it says so itself; a node that says nothing takes its parent's. */
  serves?: Serves;
  /** The act a link's stamp, a lane's press or a case's press runs. */
  acts?: string[];
};

const ADDRESS = /^\/?[A-Za-z][\w-]*(\/[A-Za-z][\w-]*)*$/;

/** `see inventory`, `no run inventory/audit/containersAuditing` → a line. Refuses any other shape. */
export function readHold(text: string, line?: number): SurfaceLine {
  const words = text.trim().split(/\s+/);
  const no = words[0] === "no";
  if (no) words.shift();
  const [verb = "", address = "", ...rest] = words;
  if (!(SURFACE_VERBS as readonly string[]).includes(verb)) throw new CrubalError(`a held line says ${SURFACE_VERBS.join(" or ")}, with no before it or nothing: ${text.trim()}`, line);
  if (rest.length || !ADDRESS.test(address)) throw new CrubalError(`a held line names one address, names joined by /: ${text.trim()}`, line);
  return { ...(no ? { no: true as const } : {}), verb: verb as SurfaceVerb, address };
}

export const holdText = (l: SurfaceLine): string => `${l.no ? "no " : ""}${l.verb} ${l.address}`;

/** The addresses on the way to one, nearest last: `a/b/c` → `a`, `a/b`, `a/b/c`. */
export function addressPath(address: string): string[] {
  const lead = address.startsWith("/") ? "/" : "";
  const parts = address.slice(lead.length).split("/");
  return parts.map((_, i) => lead + parts.slice(0, i + 1).join("/"));
}

const decided = (lines: SurfaceLine[], verb: SurfaceVerb, address: string): SurfaceAnswer => {
  const path = addressPath(address);
  for (let i = path.length - 1; i >= 0; i--) {
    const here = lines.filter((l) => l.verb === verb && l.address === path[i]);
    if (here.length) return here.some((l) => l.no) ? "no" : "yes";
  }
  return undefined;
};

/**
 * What a set of lines says of one verb at one address (14.14): the deepest line on the way to it decides, a
 * no beats a yes at the same depth, and nothing said is no answer (the package's word stands). Running needs
 * seeing: where seeing is withheld, running is too, whatever a run line says.
 */
export function surfaceAnswer(lines: SurfaceLine[], verb: SurfaceVerb, address: string): SurfaceAnswer {
  if (verb === "run" && decided(lines, "see", address) === "no") return "no";
  return decided(lines, verb, address);
}
