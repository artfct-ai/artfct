/// Mentions on the author's page, with the comments held there.
module pageFeedback {
  import feedbackRouting(ON_A_PAGE = true, FEEDBACKS = 4).* from "./feedbackRouting"
}
