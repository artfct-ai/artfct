/// A judge, then a polisher, for a harness author.
module judgeThenPolisher {
  import reviewLoopTypes.* from "./reviewLoop"
  import reviewLoop(ENTRIES = [Judge, Polisher], MODEL_CALL_AUTHOR = false).* from "./reviewLoop"
}
