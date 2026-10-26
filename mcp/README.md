# Family Chat in Claude Desktop

A small connector that lets Claude Desktop read and send family chat messages and manage the shared Notes and To-dos. It runs on your computer and logs in to the chat with your own name and password.

The **Private** tab is not available to it. Private content is encrypted with your passphrase, which the connector never has.

## Set it up (once per computer)

1. Install Node.js 18 or newer (https://nodejs.org).
2. Get the code and install its packages:
   ```sh
   git clone https://github.com/tugceozgur/family-chat.git
   cd family-chat/mcp
   npm install
   ```
3. In Claude Desktop, open **Settings → Developer → Edit Config**. That opens `claude_desktop_config.json`. Add this, using the full path to `server.js` and your own login:
   ```json
   {
     "mcpServers": {
       "family-chat": {
         "command": "node",
         "args": ["/full/path/to/family-chat/mcp/server.js"],
         "env": {
           "CHAT_URL": "https://chat.tugce.ai",
           "CHAT_NAME": "Serdar",
           "CHAT_PASSWORD": "your-chat-password"
         }
       }
     }
   }
   ```
   On Windows the path looks like `"C:\\Users\\you\\family-chat\\mcp\\server.js"`.
4. Quit Claude Desktop completely and open it again. "family-chat" shows up in the tools menu.

## Things to ask

- "What did Tugce write in the family chat today?"
- "Send Tugce: I'll be home at 6"
- "Add milk and eggs to our to-do list" / "Check off milk"
- "What's in our notes about the trip?" / "Add a note called Gift ideas"

Messages you send this way come from you, and the other person gets the usual notification.

## Tools

`read_messages`, `send_message`, `list_todos`, `add_todo`, `update_todo`, `delete_todo`, `list_notes`, `save_note`, `delete_note`.
