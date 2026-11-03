const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json()); 

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// POST Route to insert text into the database
app.post('/insert', async (req, res) => {
    const { text } = req.body;
    
    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    const { data, error } = await supabase
        .from('messages')
        .insert([{ content: text }]);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.status(200).json({ message: 'Success!' });
});

// GET Route to serve the frontend website
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Insert Text</title>
            <style>
                body { font-family: sans-serif; padding: 2rem; max-width: 500px; margin: auto; }
                input, button { padding: 10px; margin-top: 10px; width: 100%; box-sizing: border-box; }
            </style>
        </head>
        <body>
            <h2>Send a Message to Supabasesdasdasdqwdasdasdsa</h2>
            <form id="textForm">
                <input type="text" id="textInput" placeholder="Type something..." required />
                <button type="submit">Insert Text</button>
            </form>
            <p id="status"></p>

            <script>
                document.getElementById('textForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const text = document.getElementById('textInput').value;
                    const status = document.getElementById('status');
                    status.innerText = 'Inserting...';
                    
                    try {
                        const response = await fetch('/insert', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ text })
                        });
                        const result = await response.json();
                        
                        if (response.ok) {
                            status.innerText = 'Successfully inserted into Supabase!';
                            document.getElementById('textInput').value = '';
                        } else {
                            status.innerText = 'Error: ' + result.error;
                        }
                    } catch (err) {
                        status.innerText = 'Error: ' + err.message;
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// Export the Express API for Vercel
module.exports = app;

// Listen locally if not running on Vercel
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}