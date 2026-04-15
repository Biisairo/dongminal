import http.server, socketserver

class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<h1>Hello World!</h1><p>terminal.example.com is working!</p>')
		
with socketserver.TCPServer(('', 58146), H) as s:
    print('Listening on :58146')
    s.serve_forever()