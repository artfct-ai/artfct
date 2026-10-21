/// Two scheduled minutes of one trigger, with three scheduled runs, six deliveries and two
/// conversation restarts.
module twoMinutes {
  import triggerFirings(FIRINGS = 2, CHANNEL_EVENT_FIRINGS = 0, PULL_FIRINGS = 0, RUNS = 3, DELIVERIES = 6, RESTARTS = 2).* from "./triggerFirings"
}
