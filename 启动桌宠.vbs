Option Explicit

Dim shell, fileSystem, projectDirectory, electronPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

projectDirectory = FindProjectDirectory()
If Len(projectDirectory) = 0 Then
  MsgBox "Electron was not found. Keep this launcher in the project folder, or use a desktop shortcut that points to it. If the project was moved, run npm install in its folder first.", vbExclamation, "Study Companion"
  WScript.Quit 1
End If

electronPath = projectDirectory & "\node_modules\electron\dist\electron.exe"
command = """" & electronPath & """ """ & projectDirectory & """"
shell.Run command, 0, False

Function FindProjectDirectory()
  Dim candidate, desktopFolder, shortcut, shortcutFile, arguments, parts, scriptPath

  candidate = fileSystem.GetParentFolderName(WScript.ScriptFullName)
  If HasElectron(candidate) Then
    FindProjectDirectory = candidate
    Exit Function
  End If

  desktopFolder = shell.SpecialFolders("Desktop")
  If Not fileSystem.FolderExists(desktopFolder) Then Exit Function
  For Each shortcutFile In fileSystem.GetFolder(desktopFolder).Files
    If LCase(fileSystem.GetExtensionName(shortcutFile.Name)) = "lnk" Then
      Set shortcut = shell.CreateShortcut(shortcutFile.Path)
      If LCase(fileSystem.GetFileName(shortcut.TargetPath)) = "wscript.exe" Then
        arguments = shortcut.Arguments
        parts = Split(arguments, """")
        If UBound(parts) >= 2 Then
          scriptPath = parts(1)
          If LCase(fileSystem.GetFileName(scriptPath)) = LCase(WScript.ScriptName) Then
            candidate = fileSystem.GetParentFolderName(scriptPath)
            If HasElectron(candidate) Then
              FindProjectDirectory = candidate
              Exit Function
            End If
          End If
        End If
      End If
    End If
  Next
End Function

Function HasElectron(folderPath)
  HasElectron = fileSystem.FileExists(folderPath & "\node_modules\electron\dist\electron.exe")
End Function
