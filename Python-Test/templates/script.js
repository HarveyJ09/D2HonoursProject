document.getElementById('apiForm').addEventListener('submit', function(event) {
    event.preventDefault();
    const inputData = document.getElementById('inputData').value;

    // Example GET request
    fetch('https://api.example.com/getData')
        .then(response => response.json())
        .then(data => {
            document.getElementById('response').innerText = JSON.stringify(data);
        })
        .catch(error => console.error('Error:', error));

    // Example POST request
    fetch('https://api.example.com/postData', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ data: inputData })
    })
    .then(response => response.json())
    .then(data => {
        document.getElementById('response').innerText = JSON.stringify(data);
    })
    .catch(error => console.error('Error:', error));
});