' Launch CRM app window (hidden console): ensure local service, then open Edge/Chrome in app mode.
' ASCII-only on purpose: wscript.exe reads ANSI/UTF-16, not UTF-8.

Option Explicit

Dim fso, sh, root, url, edge1, edge2, chrome1, chrome2, browser, i

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://127.0.0.1:8899/"

Function ServerUp()
  Dim http
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1500, 1500, 2000, 2000
  http.Open "GET", url & "api/health", False
  http.Send
  ServerUp = (Err.Number = 0 And http.Status = 200)
  Err.Clear
  On Error GoTo 0
End Function

If Not ServerUp() Then
  sh.Run "cmd /c cd /d """ & root & """ && start """" /min ""启动.bat""", 0, False
  For i = 1 To 30
    WScript.Sleep 1000
    If ServerUp() Then Exit For
  Next
End If

edge1 = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
edge2 = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"
chrome1 = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe"
chrome2 = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe"

If fso.FileExists(edge1) Then
  browser = edge1
ElseIf fso.FileExists(edge2) Then
  browser = edge2
ElseIf fso.FileExists(chrome1) Then
  browser = chrome1
ElseIf fso.FileExists(chrome2) Then
  browser = chrome2
Else
  MsgBox "Edge or Chrome not found.", 48, "CRM"
  WScript.Quit 1
End If

sh.Run """" & browser & """ --app=" & url & " --window-size=1440,900", 1, False
