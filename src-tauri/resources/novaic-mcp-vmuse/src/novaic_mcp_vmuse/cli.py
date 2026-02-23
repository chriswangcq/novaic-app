"""
NovAIC CLI - Command line interface
"""

import argparse
from pathlib import Path

from .config import settings


def main():
    """Main CLI entry point"""
    parser = argparse.ArgumentParser(
        description="NovAIC - Linux Desktop MCP Server (FastMCP)"
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Commands")
    
    # serve command
    serve_parser = subparsers.add_parser("serve", help="Start the MCP server")
    serve_parser.add_argument(
        "--host", 
        default=settings.host,
        help=f"Host to bind (default: {settings.host})"
    )
    serve_parser.add_argument(
        "--port", 
        type=int, 
        default=settings.port,
        help=f"Port to bind (default: {settings.port})"
    )
    serve_parser.add_argument(
        "--transport",
        choices=["sse", "stdio"],
        default="sse",
        help="Transport mode (default: sse)"
    )
    
    # version command
    subparsers.add_parser("version", help="Show version")
    
    # info command
    subparsers.add_parser("info", help="Show server info and available tools")
    
    # skills command
    subparsers.add_parser("skills", help="List available skills")
    
    args = parser.parse_args()
    
    if args.command == "serve" or args.command is None:
        # Default to serve
        host = getattr(args, 'host', settings.host)
        port = getattr(args, 'port', settings.port)
        transport = getattr(args, 'transport', 'sse')
        
        # 获取 skills 目录
        skills_dir = Path(__file__).parent.parent.parent / "skills"
        skills_count = len(list(skills_dir.glob('*/SKILL.md'))) if skills_dir.exists() else 0
        
        print(f"""
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🐧 NovAIC - Linux Desktop MCP Server (FastMCP v0.2.0)     ║
║                                                               ║
║   Transport: {transport.upper():5}                                        ║
║   SSE Endpoint: http://{host}:{port}/sse                      ║
║   Health Check: http://{host}:{port}/health                   ║
║                                                               ║
║   Skills: {skills_count} loaded                                          ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
        """)
        
        from .main import mcp
        
        if transport == "stdio":
            # stdio 模式 - 用于 Claude Desktop 等
            mcp.run(transport="stdio")
        else:
            # SSE 模式 - HTTP 服务器
            mcp.run(transport="sse", host=host, port=port)
    
    elif args.command == "version":
        print("novaic 0.2.0 (FastMCP)")
    
    elif args.command == "info":
        from .main import SKILLS_DIR
        
        print(f"\nNovAIC - FastMCP Server")
        print(f"Version: 0.2.0\n")
        
        # 列出 skills
        if SKILLS_DIR.exists():
            skills = list(SKILLS_DIR.glob('*/SKILL.md'))
            print(f"Skills ({len(skills)}):")
            for skill_file in sorted(skills):
                skill_name = skill_file.parent.name
                print(f"  - skill://{skill_name}")
        
        print("\nTools: 44+ available")
        print("  Use 'novaic skills' to list skill details")
    
    elif args.command == "skills":
        from .main import SKILLS_DIR
        
        print("\n📚 Available Skills:\n")
        
        if SKILLS_DIR.exists():
            for skill_dir in sorted(SKILLS_DIR.iterdir()):
                skill_file = skill_dir / "SKILL.md"
                if skill_file.exists():
                    # 读取 skill 描述
                    content = skill_file.read_text()
                    description = ""
                    
                    # 解析 YAML frontmatter
                    if content.startswith("---"):
                        lines = content.split("\n")
                        for line in lines[1:]:
                            if line.strip() == "---":
                                break
                            if line.startswith("description:"):
                                description = line.replace("description:", "").strip()
                    
                    print(f"  📖 {skill_dir.name}")
                    if description:
                        print(f"     {description[:70]}...")
                    print(f"     URI: skill://{skill_dir.name}")
                    print()
        else:
            print("  No skills found.")


if __name__ == "__main__":
    main()
