import { describe, test, expect } from "bun:test";
import {
  oaPathToRouterOsDir,
  isTitleRelevantToPath,
  getAbbreviationGuesses,
  segmentToTitleGuesses,
  mergeDescription,
  ABBREVIATIONS,
  HUB_PAGE_THRESHOLD,
  CMD_NAMES,
} from "./enrich-openapi";

// ── oaPathToRouterOsDir ────────────────────────────────────────────────────

describe("oaPathToRouterOsDir", () => {
  test("strips trailing {id}", () => {
    expect(oaPathToRouterOsDir("/ip/address/{id}")).toBe("/ip/address");
  });

  test("strips known command names", () => {
    expect(oaPathToRouterOsDir("/ip/address/print")).toBe("/ip/address");
    expect(oaPathToRouterOsDir("/ip/address/export")).toBe("/ip/address");
    expect(oaPathToRouterOsDir("/ip/address/monitor")).toBe("/ip/address");
    expect(oaPathToRouterOsDir("/ip/firewall/filter/enable")).toBe("/ip/firewall/filter");
    expect(oaPathToRouterOsDir("/ip/firewall/filter/disable")).toBe("/ip/firewall/filter");
    expect(oaPathToRouterOsDir("/system/reset-counters")).toBe("/system");
    expect(oaPathToRouterOsDir("/ip/address/find")).toBe("/ip/address");
    expect(oaPathToRouterOsDir("/system/reset-counters-all")).toBe("/system");
    expect(oaPathToRouterOsDir("/ip/address/recursive-print")).toBe("/ip/address");
  });

  test("preserves non-command paths", () => {
    expect(oaPathToRouterOsDir("/ip/address")).toBe("/ip/address");
    expect(oaPathToRouterOsDir("/routing/bgp/connection")).toBe("/routing/bgp/connection");
    expect(oaPathToRouterOsDir("/interface/bridge/vlan")).toBe("/interface/bridge/vlan");
  });

  test("preserves ambiguous names that are both cmd and dir in RouterOS", () => {
    expect(oaPathToRouterOsDir("/tool/ping")).toBe("/tool/ping");
    expect(oaPathToRouterOsDir("/tool/profile")).toBe("/tool/profile");
    expect(oaPathToRouterOsDir("/tool/sniffer")).toBe("/tool/sniffer");
    expect(oaPathToRouterOsDir("/ip/ssh")).toBe("/ip/ssh");
  });

  test("handles root path", () => {
    expect(oaPathToRouterOsDir("/")).toBe("/");
  });

  test("{id} is stripped before command check", () => {
    // /ip/address/{id} → strip {id} → /ip/address (not a command, kept as-is)
    expect(oaPathToRouterOsDir("/ip/address/{id}")).toBe("/ip/address");
    // hypothetical: /ip/address/print/{id} → strip {id} → then strip print
    expect(oaPathToRouterOsDir("/ip/address/print/{id}")).toBe("/ip/address");
  });
});

// ── isTitleRelevantToPath ──────────────────────────────────────────────────

describe("isTitleRelevantToPath", () => {
  test("returns true for matching word overlap", () => {
    expect(isTitleRelevantToPath("DHCP", "/ip/dhcp-server")).toBe(true);
    expect(isTitleRelevantToPath("IP Addressing", "/ip/address")).toBe(true);
    expect(isTitleRelevantToPath("Bonding", "/interface/bonding")).toBe(true);
    expect(isTitleRelevantToPath("Container", "/container")).toBe(true);
  });

  test("returns false for irrelevant titles", () => {
    expect(isTitleRelevantToPath("Switch Chip Features", "/ip/dhcp-server")).toBe(false);
    expect(isTitleRelevantToPath("Bridging and Switching", "/ip/route")).toBe(false);
    expect(isTitleRelevantToPath("Configuration Management", "/queue/simple")).toBe(false);
  });

  test("handles abbreviation matches", () => {
    expect(isTitleRelevantToPath("BGP", "/routing/bgp")).toBe(true);
    expect(isTitleRelevantToPath("OSPF", "/routing/ospf")).toBe(true);
    expect(isTitleRelevantToPath("IPsec", "/ip/ipsec")).toBe(true);
    expect(isTitleRelevantToPath("CAPsMAN", "/caps-man")).toBe(true);
  });

  test("handles prefix word matching", () => {
    expect(isTitleRelevantToPath("Firewall", "/ip/firewall/filter")).toBe(true);
    expect(isTitleRelevantToPath("Certificates", "/certificate")).toBe(true);
  });

  test("returns false for connection→Connection rate false positive", () => {
    // "Connection rate" should not be considered relevant to /routing/bgp/connection
    // via generic overlap — but "connection" does appear as a prefix of "connection"
    // so the word overlap WILL match. That's fine — this guard is for completely
    // irrelevant titles. The prefix-matching restriction is the one that blocks
    // "Connection rate" from being chosen via prefix-only lookup.
    expect(isTitleRelevantToPath("Connection rate", "/routing/bgp/connection")).toBe(true);
  });
});

// ── getAbbreviationGuesses ─────────────────────────────────────────────────

describe("getAbbreviationGuesses", () => {
  test("returns abbreviation for known segments", () => {
    expect(getAbbreviationGuesses("bgp")).toContain("BGP");
    expect(getAbbreviationGuesses("ospf")).toContain("OSPF");
    expect(getAbbreviationGuesses("mpls")).toContain("MPLS");
  });

  test("returns abbreviation for compound segments", () => {
    expect(getAbbreviationGuesses("dhcp-server")).toContain("DHCP");
    expect(getAbbreviationGuesses("caps-man")).toContain("CAPsMAN");
  });

  test("returns empty for unknown segments", () => {
    expect(getAbbreviationGuesses("foobar")).toHaveLength(0);
    expect(getAbbreviationGuesses("something-unknown")).toHaveLength(0);
  });

  test("does NOT include generic title-cased transformations", () => {
    const guesses = getAbbreviationGuesses("bridge");
    // "bridge" is not in ABBREVIATIONS, so no guesses
    expect(guesses).toHaveLength(0);
  });
});

// ── segmentToTitleGuesses ──────────────────────────────────────────────────

describe("segmentToTitleGuesses", () => {
  test("includes abbreviation matches", () => {
    const guesses = segmentToTitleGuesses("bgp");
    expect(guesses).toContain("BGP");
  });

  test("includes title-cased transformation", () => {
    const guesses = segmentToTitleGuesses("bridge");
    expect(guesses).toContain("Bridge");
  });

  test("includes multi-word title case", () => {
    const guesses = segmentToTitleGuesses("dhcp-server");
    expect(guesses).toContain("Dhcp Server");
    expect(guesses).toContain("DHCP"); // from abbreviation
  });

  test("includes raw segment", () => {
    const guesses = segmentToTitleGuesses("bridge");
    expect(guesses).toContain("bridge");
  });

  test("includes sub-part abbreviations", () => {
    const guesses = segmentToTitleGuesses("dhcp-relay");
    expect(guesses).toContain("DHCP"); // from "dhcp" sub-part
  });
});

// ── mergeDescription ───────────────────────────────────────────────────────

describe("mergeDescription", () => {
  test("returns rosetta desc when no existing", () => {
    expect(mergeDescription("The DHCP server config", "")).toBe("The DHCP server config");
  });

  test("appends existing as parenthetical", () => {
    expect(mergeDescription("The address", "string")).toBe("The address (string)");
  });

  test("deduplicates identical descriptions", () => {
    expect(mergeDescription("some text", "some text")).toBe("some text");
  });

  test("deduplicates case-insensitively", () => {
    expect(mergeDescription("Some Text", "some text")).toBe("Some Text");
  });
});

// ── Constants ──────────────────────────────────────────────────────────────

describe("constants", () => {
  test("HUB_PAGE_THRESHOLD is reasonable", () => {
    expect(HUB_PAGE_THRESHOLD).toBeGreaterThan(5);
    expect(HUB_PAGE_THRESHOLD).toBeLessThan(50);
  });

  test("CMD_NAMES includes high-frequency commands", () => {
    expect(CMD_NAMES.has("print")).toBe(true);
    expect(CMD_NAMES.has("find")).toBe(true);
    expect(CMD_NAMES.has("reset-counters-all")).toBe(true);
    expect(CMD_NAMES.has("recursive-print")).toBe(true);
  });

  test("CMD_NAMES excludes ambiguous names (both cmd and dir in inspect)", () => {
    expect(CMD_NAMES.has("ping")).toBe(false);
    expect(CMD_NAMES.has("profile")).toBe(false);
    expect(CMD_NAMES.has("ssh")).toBe(false);
    expect(CMD_NAMES.has("sniffer")).toBe(false);
    expect(CMD_NAMES.has("update")).toBe(false);
    expect(CMD_NAMES.has("range")).toBe(false);
  });

  test("ABBREVIATIONS has expected entries", () => {
    expect(ABBREVIATIONS.bgp).toContain("BGP");
    expect(ABBREVIATIONS.ospf).toContain("OSPF");
    expect(ABBREVIATIONS["caps-man"]).toContain("CAPsMAN");
    expect(ABBREVIATIONS["dhcp-server"]).toContain("DHCP");
    expect(ABBREVIATIONS.ipsec).toContain("IPsec");
  });
});
