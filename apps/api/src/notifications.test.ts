import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NotificationStore } from "./notifications.js";

describe("NotificationStore", () => {
  it("dedupes unread review_requested for the same recipient+ticket", () => {
    const store = new NotificationStore(":memory:");
    const first = store.notify({
      recipient: "joostvl",
      type: "review_requested",
      project: "traceai",
      ticket_slug: "tra-99",
      ticket_key: "TRA-99",
      title: "Example",
      stage: "review",
      deeplink: "/projects/traceai/tickets/tra-99",
    });
    assert.ok(first);
    const second = store.notify({
      recipient: "joostvl",
      type: "review_requested",
      project: "traceai",
      ticket_slug: "tra-99",
      title: "Example",
      stage: "review",
      deeplink: "/projects/traceai/tickets/tra-99",
    });
    assert.equal(second, null);
    assert.equal(store.unreadCount("joostvl"), 1);
  });

  it("lists and marks read only for the owner", () => {
    const store = new NotificationStore(":memory:");
    store.notify({
      recipient: "a",
      type: "review_requested",
      project: "traceai",
      ticket_slug: "t1",
      title: "One",
      stage: "in_refinement",
      deeplink: "/x",
    });
    store.notify({
      recipient: "b",
      type: "review_requested",
      project: "traceai",
      ticket_slug: "t1",
      title: "One",
      stage: "in_refinement",
      deeplink: "/x",
    });
    assert.equal(store.listForRecipient("a").length, 1);
    assert.equal(store.markRead("a", store.listForRecipient("a")[0]!.id), true);
    assert.equal(store.unreadCount("a"), 0);
    assert.equal(store.unreadCount("b"), 1);
    assert.equal(store.markRead("a", store.listForRecipient("b")[0]!.id), false);
  });

  it("marks ticket review notifications read after a verdict", () => {
    const store = new NotificationStore(":memory:");
    store.notify({
      recipient: "a",
      type: "review_requested",
      project: "traceai",
      ticket_slug: "t1",
      title: "One",
      stage: "review",
      deeplink: "/x",
    });
    store.notify({
      recipient: "b",
      type: "review_cascaded",
      project: "traceai",
      ticket_slug: "t1",
      title: "One",
      stage: "review",
      deeplink: "/x",
    });
    assert.equal(store.markTicketReviewRead("t1"), 2);
    assert.equal(store.unreadCount("a"), 0);
    assert.equal(store.unreadCount("b"), 0);
  });
});
