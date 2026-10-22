' Windows launcher for the pagesnap UI: starts it with no console window (or finds the copy
' already running) and opens it in a window of its own. `npm run shortcut` makes a Start menu
' shortcut to this file that you can pin to the taskbar.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "node """ & root & "\bin\pagesnap.js"" --ui --app", 0, False
