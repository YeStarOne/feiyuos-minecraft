' hidden launcher: wscript start-hidden.vbs <bat path>
CreateObject("Wscript.Shell").Run """" & WScript.Arguments(0) & """", 0, False
