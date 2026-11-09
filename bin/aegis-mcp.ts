import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {createMcpServer} from "../lib/agent/mcp-server";
import {authenticateAgent} from "../lib/agent/agent-token";
import {proxyToolCall} from "../lib/agent/mcp-proxy";
try{
 if(process.env.AEGIS_MCP_BASE_URL){
  const {Client}=await import("@modelcontextprotocol/sdk/client/index.js");
  const {StreamableHTTPClientTransport}=await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const {Server}=await import("@modelcontextprotocol/sdk/server/index.js");
  const {ListToolsRequestSchema,CallToolRequestSchema}=await import("@modelcontextprotocol/sdk/types.js");
  const base=new URL(process.env.AEGIS_MCP_BASE_URL);if(base.protocol!=="https:"&&base.hostname!=="localhost"&&base.hostname!=="127.0.0.1")throw new Error("HTTPS is required.");
  const client=new Client({name:"binder-stdio-proxy",version:"1.0.0"});await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp",base),{requestInit:{headers:{Authorization:`Bearer ${process.env.AEGIS_AGENT_TOKEN??""}`}}}));
  const proxy=new Server({name:"binder-stdio-proxy",version:"1.0.0"},{capabilities:{tools:{}}});proxy.setRequestHandler(ListToolsRequestSchema,()=>client.listTools());proxy.setRequestHandler(CallToolRequestSchema,r=>proxyToolCall(client,r.params));await proxy.connect(new StdioServerTransport());
 }else{const i=process.argv.indexOf("--origin"),origin=new URL(i<0?"http://localhost:3000":process.argv[i+1]);if(!["http:","https:"].includes(origin.protocol)||origin.username||origin.password)throw new Error("Invalid public origin.");await authenticateAgent(process.env.AEGIS_AGENT_TOKEN);await createMcpServer(()=>process.env.AEGIS_AGENT_TOKEN,origin.origin).connect(new StdioServerTransport());}
}catch{process.stderr.write("MCP connection failed; check credential, backend and storage configuration.\n");process.exitCode=1;}
