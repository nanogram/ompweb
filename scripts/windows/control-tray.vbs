Option Explicit

Dim fso, shell, scriptDir, controller, action, configPath, winDir, psExe, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count <> 2 Then WScript.Quit 2
action = LCase(WScript.Arguments.Item(0))
If action <> "stop" And action <> "restart" Then WScript.Quit 2
configPath = WScript.Arguments.Item(1)
If InStr(configPath, Chr(34)) > 0 Then WScript.Quit 2

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
controller = fso.BuildPath(scriptDir, "control-tray.ps1")
If Not fso.FileExists(controller) Or Not fso.FileExists(configPath) Then WScript.Quit 2
winDir = shell.ExpandEnvironmentStrings("%SystemRoot%")
If winDir = "%SystemRoot%" Or winDir = "" Then winDir = "C:\Windows"
psExe = fso.BuildPath(winDir, "System32\WindowsPowerShell\v1.0\powershell.exe")

command = Chr(34) & psExe & Chr(34) & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & controller & Chr(34) & " -Action " & action & " -ConfigPath " & Chr(34) & configPath & Chr(34) & " -Delay"
' Exit before the delayed controller stops the web caller's entire process tree.
On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then WScript.Quit 1
WScript.Quit 0
