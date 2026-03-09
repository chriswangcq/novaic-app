"""
Shell Tools - Execute commands and Python code

Simplified in v4: synchronous execution with timeout protection.
For long-running commands (>30s), use subagent_spawn to run in background.
"""

import asyncio
import os
import shlex
from typing import Dict, Any, Optional

from ..config import settings


# Default timeout for command execution (seconds)
DEFAULT_TIMEOUT = 30
# Maximum lines to return in output
MAX_OUTPUT_LINES = 100


class ShellTools:
    """Shell execution tools - simple sync execution with timeout"""
    
    @staticmethod
    async def run_command(
        command: str,
        cwd: Optional[str] = None,
        timeout: Optional[int] = None,
        visible: bool = False,
        runtime_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Execute shell command synchronously with timeout protection.
        
        Return format: { success, stdout, stderr, exit_code, ... }
        - success: true if command execution completed (regardless of exit_code)
        - exit_code: process exit code (None if timed out), LLM should interpret based on context
        - warning: present if command timed out
        
        Timeout behavior:
        - Default timeout: 30 seconds
        - If command doesn't complete in time, returns partial output with warning
        - For long-running commands (>30s), use subagent_spawn
        
        For long-running commands (builds, downloads, etc.):
        Use subagent_spawn for long commands: subagent_spawn(task="Run: npm run build")
        
        Recommended usage:
        - Quick commands (ls, cat, etc.): run_command(command="ls -la")
        - Medium commands (installs): run_command(command="pip install pkg", timeout=60)
        - Long commands: Use subagent_spawn instead!
        
        Examples:
            run_command(command="ls -la")  # Fast command
            run_command(command="cat file.txt")  # Read file
            run_command(command="apt update", timeout=60)  # Medium command with longer timeout
        
        Args:
            command: Shell command to execute
            cwd: Working directory (default: settings.work_dir)
            timeout: Maximum execution time in seconds (default: 30)
            visible: If true, run in visible terminal (for GUI apps)
        
        Returns:
            Dictionary with success, stdout, stderr, exit_code, truncated, warning
        """
        try:
            work_dir = cwd or ShellTools._default_work_dir(runtime_context)
            os.makedirs(work_dir, exist_ok=True)
            
            if visible:
                return await ShellTools._run_visible(command, work_dir, timeout or 60, runtime_context)
            
            return await ShellTools._run_sync(command, work_dir, timeout or DEFAULT_TIMEOUT, runtime_context)
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "stdout": "",
                "stderr": "",
                "exit_code": -1
            }
    
    @staticmethod
    async def _run_sync(
        command: str,
        cwd: str,
        timeout: int,
        runtime_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Run command synchronously with timeout.
        If timeout occurs, returns partial output and warning.
        """
        env = ShellTools._get_env_with_display(runtime_context)
        process = await ShellTools._spawn_shell_process(command, cwd, env, runtime_context)
        
        try:
            # Wait for command to complete with timeout
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout
            )
            
            stdout = stdout_bytes.decode('utf-8', errors='replace')
            stderr = stderr_bytes.decode('utf-8', errors='replace')
            
            # Truncate output if too long
            stdout_truncated, stdout_lines = ShellTools._truncate_output(stdout)
            stderr_truncated, stderr_lines = ShellTools._truncate_output(stderr)
            
            # 注意：success=True 表示命令执行完成（无论 exit_code 是多少）
            # exit_code 由 LLM 根据上下文判断是否符合预期
            return {
                "success": True,
                "stdout": stdout_truncated,
                "stderr": stderr_truncated,
                "exit_code": process.returncode,
                "stdout_lines": stdout_lines,
                "stderr_lines": stderr_lines,
                "truncated": stdout_lines > MAX_OUTPUT_LINES or stderr_lines > MAX_OUTPUT_LINES,
            }
            
        except asyncio.TimeoutError:
            # Command timed out - try to get partial output
            partial_stdout = ""
            partial_stderr = ""
            
            try:
                # Try to read any available output before terminating
                process.terminate()
                await asyncio.sleep(0.5)
                
                if process.returncode is None:
                    process.kill()
                
                # Read any buffered output
                try:
                    stdout_bytes = await asyncio.wait_for(
                        process.stdout.read(),
                        timeout=1.0
                    )
                    partial_stdout = stdout_bytes.decode('utf-8', errors='replace')
                except:
                    pass
                
                try:
                    stderr_bytes = await asyncio.wait_for(
                        process.stderr.read(),
                        timeout=1.0
                    )
                    partial_stderr = stderr_bytes.decode('utf-8', errors='replace')
                except:
                    pass
                    
            except Exception:
                pass
            
            stdout_truncated, stdout_lines = ShellTools._truncate_output(partial_stdout)
            stderr_truncated, stderr_lines = ShellTools._truncate_output(partial_stderr)
            
            return {
                "success": False,
                "stdout": stdout_truncated,
                "stderr": stderr_truncated,
                "exit_code": None,
                "stdout_lines": stdout_lines,
                "stderr_lines": stderr_lines,
                "truncated": True,
                "timed_out": True,
                "warning": f"Command timed out after {timeout}s. For long-running commands, use subagent_spawn(task='Run: ...').",
            }
    
    @staticmethod
    def _truncate_output(output: str) -> tuple:
        """
        Truncate output to last MAX_OUTPUT_LINES lines.
        Returns (truncated_output, total_lines).
        """
        if not output:
            return "", 0
        
        lines = output.splitlines()
        total = len(lines)
        
        if total <= MAX_OUTPUT_LINES:
            return output, total
        
        # Return last MAX_OUTPUT_LINES lines
        truncated = '\n'.join(lines[-MAX_OUTPUT_LINES:])
        return f"[... {total - MAX_OUTPUT_LINES} lines truncated ...]\n{truncated}", total
    
    @staticmethod
    def _get_env_with_display(runtime_context: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
        """Get environment variables with DISPLAY set for GUI apps"""
        env = os.environ.copy()

        if runtime_context:
            display = runtime_context.get("display")
            if display:
                env["DISPLAY"] = str(display)

            home_path = runtime_context.get("home_path")
            if home_path:
                env["HOME"] = str(home_path)

            linux_user = runtime_context.get("linux_user")
            if linux_user:
                env["USER"] = str(linux_user)
                env["LOGNAME"] = str(linux_user)
                env["XDG_RUNTIME_DIR"] = f"/tmp/runtime-{linux_user}"

        if "DISPLAY" not in env:
            env["DISPLAY"] = ":0"

        if "XAUTHORITY" not in env:
            xauth_path = os.path.expanduser("~/.Xauthority.x0")
            if os.path.exists(xauth_path):
                env["XAUTHORITY"] = xauth_path
            else:
                xauth_default = os.path.expanduser("~/.Xauthority")
                if os.path.exists(xauth_default):
                    env["XAUTHORITY"] = xauth_default
        
        return env

    @staticmethod
    def _default_work_dir(runtime_context: Optional[Dict[str, Any]] = None) -> str:
        if runtime_context and runtime_context.get("home_path"):
            return str(runtime_context["home_path"])
        return settings.work_dir

    @staticmethod
    def _target_user(runtime_context: Optional[Dict[str, Any]] = None) -> Optional[str]:
        if runtime_context:
            user = runtime_context.get("linux_user")
            if user:
                return str(user)
        return None

    @staticmethod
    def _should_sudo(runtime_context: Optional[Dict[str, Any]] = None) -> bool:
        user = ShellTools._target_user(runtime_context)
        if not user:
            return False
        return user != os.environ.get("USER", "")

    @staticmethod
    async def _spawn_shell_process(
        command: str,
        cwd: str,
        env: Dict[str, str],
        runtime_context: Optional[Dict[str, Any]] = None,
    ):
        if not ShellTools._should_sudo(runtime_context):
            return await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=env
            )

        target_user = ShellTools._target_user(runtime_context)
        wrapped_command = command
        if cwd:
            wrapped_command = f"cd {shlex.quote(cwd)} && {command}"

        env_args = [
            "env",
            f"DISPLAY={env.get('DISPLAY', ':0')}",
            f"HOME={env.get('HOME', cwd)}",
            f"USER={target_user}",
            f"LOGNAME={target_user}",
            f"XDG_RUNTIME_DIR={env.get('XDG_RUNTIME_DIR', f'/tmp/runtime-{target_user}')}",
            f"PATH={env.get('PATH', os.environ.get('PATH', ''))}",
        ]
        if env.get("XAUTHORITY"):
            env_args.append(f"XAUTHORITY={env['XAUTHORITY']}")

        return await asyncio.create_subprocess_exec(
            "sudo",
            "-u",
            str(target_user),
            "-H",
            *env_args,
            "bash",
            "-lc",
            wrapped_command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
    
    @staticmethod
    async def _run_visible(
        command: str, 
        cwd: str, 
        timeout: int,
        runtime_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Run command in visible terminal (for GUI apps)"""
        env = ShellTools._get_env_with_display(runtime_context)
        target_user = ShellTools._target_user(runtime_context)
        wrapped_command = command
        if ShellTools._should_sudo(runtime_context):
            env_exports = " ".join([
                f"{key}={shlex.quote(value)}"
                for key, value in {
                    "DISPLAY": env.get("DISPLAY", ":0"),
                    "HOME": env.get("HOME", cwd),
                    "USER": target_user or "",
                    "LOGNAME": target_user or "",
                    "XDG_RUNTIME_DIR": env.get("XDG_RUNTIME_DIR", f"/tmp/runtime-{target_user}"),
                    "PATH": env.get("PATH", os.environ.get("PATH", "")),
                }.items()
                if value
            ])
            wrapped_command = f"sudo -u {shlex.quote(str(target_user))} -H env {env_exports} bash -lc {shlex.quote(command)}"

        # Create a wrapper script
        script_content = f"""#!/bin/bash
cd {shlex.quote(cwd)}
{wrapped_command}
echo ""
echo "=== Command finished (exit code: $?) ==="
sleep 3
"""
        script_path = f"/tmp/novaic_visible_{os.getpid()}.sh"
        with open(script_path, 'w') as f:
            f.write(script_content)
        os.chmod(script_path, 0o755)
        
        # Run in xterm
        xterm_cmd = [
            "xterm",
            "-geometry", "120x40",
            "-title", f"NovAIC: {command[:50]}",
            "-e", script_path
        ]
        
        process = await asyncio.create_subprocess_exec(
            *xterm_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        
        # Wait for terminal to close or timeout
        try:
            await asyncio.wait_for(process.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            process.terminate()
        
        # Cleanup
        if os.path.exists(script_path):
            os.unlink(script_path)
        
        return {
            "success": True,
            "stdout": "(Command ran in visible terminal)",
            "stderr": "",
            "exit_code": 0,
            "visible": True
        }
    
    @staticmethod
    async def run_python(
        code: str,
        timeout: Optional[int] = None,
        visible: bool = False,
        runtime_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Execute Python code.
        
        Args:
            code: Python code to execute
            timeout: Execution timeout in seconds
            visible: If true, run in visible terminal
        """
        # Write code to temp file
        script_path = f"/tmp/novaic_python_{os.getpid()}.py"
        with open(script_path, 'w') as f:
            f.write(code)
        
        try:
            result = await ShellTools.run_command(
                f"python3 {script_path}",
                timeout=timeout,
                visible=visible,
                runtime_context=runtime_context,
            )
            return result
        finally:
            if os.path.exists(script_path):
                os.unlink(script_path)
