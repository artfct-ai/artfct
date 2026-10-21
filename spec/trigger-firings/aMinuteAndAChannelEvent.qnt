/// One scheduled minute and one vendor event whose trigger reports in a channel, with three first
/// attempts, six deliveries and two conversation restarts.
module aMinuteAndAChannelEvent {
  import triggerFirings(FIRINGS = 1, CHANNEL_EVENT_FIRINGS = 1, PULL_FIRINGS = 0, RUNS = 3, DELIVERIES = 6, RESTARTS = 2).* from "./triggerFirings"
}
