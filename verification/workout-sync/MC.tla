---------------------------- MODULE MC ----------------------------
(* The scenario TLC checks: 1 is set.log, which creates set S; 2 and 3 *)
(* are set.edit of S, logged in that order (domain/workout dependsOn).  *)
EXTENDS WorkoutSync

MCDep == {<<2, 1>>, <<3, 1>>, <<3, 2>>}
===================================================================
