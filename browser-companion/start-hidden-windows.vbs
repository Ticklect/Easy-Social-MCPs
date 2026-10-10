Option Explicit
Dim shell, files, scriptFolder
Set files = CreateObject("Scripting.FileSystemObject")
scriptFolder = files.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = scriptFolder
' Startup is opted into separately. A paired extension reconnects to this server.
shell.Run Chr(34) & scriptFolder & "\start-windows.cmd" & Chr(34) & " --background", 0, False
