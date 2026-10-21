/// Two events on one pull request that fire one definition, with four router queues, seven
/// deliveries and two conversation restarts.
module pullRequestEvents {
  import triggerFirings(FIRINGS = 0, CHANNEL_EVENT_FIRINGS = 0, PULL_FIRINGS = 2, RUNS = 4, DELIVERIES = 7, RESTARTS = 2).* from "./triggerFirings"
}
