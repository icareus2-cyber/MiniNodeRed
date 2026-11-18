@echo off
rem Opens the Microflow accounts window (add users, set passwords).
where pythonw >nul 2>nul && (start "" pythonw "%~dp0user_manager.py" & exit /b)
python "%~dp0user_manager.py"
