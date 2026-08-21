import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  boardHref,
  isBoardActive,
  isPageActive,
  menuOpenAfter,
  sortWorkflowsForNav,
  ticketsHref,
} from "./project-nav.js";

const project = "traceai";
const defaultWf = "traceai-default";
const named = "standard-worker";

describe("TRA-93 project nav helpers", () => {
  it("T1: boardHref default has no query", () => {
    assert.equal(boardHref(project, defaultWf, defaultWf), `/projects/${project}`);
  });

  it("T2: boardHref named uses encoded workflow query", () => {
    assert.equal(
      boardHref(project, named, defaultWf),
      `/projects/${project}?workflow=${named}`,
    );
    assert.equal(
      boardHref(project, "a/b", defaultWf),
      `/projects/${project}?workflow=${encodeURIComponent("a/b")}`,
    );
  });

  it("T3: default board is active without query", () => {
    assert.equal(
      isBoardActive({
        pathname: `/projects/${project}`,
        workflowQuery: undefined,
        projectSlug: project,
        workflowSlug: defaultWf,
        defaultWorkflow: defaultWf,
      }),
      true,
    );
    assert.equal(
      isBoardActive({
        pathname: `/projects/${project}`,
        workflowQuery: undefined,
        projectSlug: project,
        workflowSlug: named,
        defaultWorkflow: defaultWf,
      }),
      false,
    );
  });

  it("T4: named board is active with matching query", () => {
    assert.equal(
      isBoardActive({
        pathname: `/projects/${project}`,
        workflowQuery: named,
        projectSlug: project,
        workflowSlug: named,
        defaultWorkflow: defaultWf,
      }),
      true,
    );
    assert.equal(
      isBoardActive({
        pathname: `/projects/${project}`,
        workflowQuery: named,
        projectSlug: project,
        workflowSlug: defaultWf,
        defaultWorkflow: defaultWf,
      }),
      false,
    );
  });

  it("T5: insights is not a board", () => {
    assert.equal(
      isBoardActive({
        pathname: `/projects/${project}/insights`,
        workflowQuery: undefined,
        projectSlug: project,
        workflowSlug: defaultWf,
        defaultWorkflow: defaultWf,
      }),
      false,
    );
  });

  it("T6: ticket detail is not a board", () => {
    assert.equal(
      isBoardActive({
        pathname: `/projects/${project}/tickets/foo`,
        workflowQuery: undefined,
        projectSlug: project,
        workflowSlug: defaultWf,
        defaultWorkflow: defaultWf,
      }),
      false,
    );
  });

  it("T7: wiki index and page are both Wiki", () => {
    assert.equal(
      isPageActive(`/projects/${project}/wiki`, project, "wiki"),
      true,
    );
    assert.equal(
      isPageActive(`/projects/${project}/wiki/home`, project, "wiki"),
      true,
    );
    assert.equal(
      isPageActive(`/projects/${project}/insights`, project, "wiki"),
      false,
    );
  });

  it("T8: settings stays active with tab query (pathname only)", () => {
    assert.equal(
      isPageActive(`/projects/${project}/settings`, project, "settings"),
      true,
    );
  });

  it("T12: tokens page is a project page, not a board", () => {
    assert.equal(
      isPageActive(`/projects/${project}/tokens`, project, "tokens"),
      true,
    );
    assert.equal(
      isBoardActive({
        pathname: `/projects/${project}/tokens`,
        workflowQuery: undefined,
        projectSlug: project,
        workflowSlug: defaultWf,
        defaultWorkflow: defaultWf,
      }),
      false,
    );
  });

  it("T10: sortWorkflowsForNav puts default first, then name", () => {
    const sorted = sortWorkflowsForNav(
      [
        { slug: "zulu", name: "Zulu" },
        { slug: defaultWf, name: "Default" },
        { slug: "alpha", name: "Alpha" },
      ],
      defaultWf,
    );
    assert.deepEqual(
      sorted.map((w) => w.slug),
      [defaultWf, "alpha", "zulu"],
    );
  });

  it("T11: drawer close (escape / overlay / navigate) always closes", () => {
    assert.equal(menuOpenAfter(true, "close"), false);
    assert.equal(menuOpenAfter(false, "close"), false);
    assert.equal(menuOpenAfter(false, "toggle"), true);
    assert.equal(menuOpenAfter(true, "toggle"), false);
  });

  it("T14: tickets list is active on the exact list URL", () => {
    assert.equal(
      isPageActive(`/projects/${project}/tickets`, project, "tickets"),
      true,
    );
  });

  it("T15: ticket detail does not highlight Tickets", () => {
    assert.equal(
      isPageActive(`/projects/${project}/tickets/foo`, project, "tickets"),
      false,
    );
  });

  it("T16: ticketsHref is /projects/:slug/tickets", () => {
    assert.equal(ticketsHref(project), `/projects/${project}/tickets`);
  });
});
