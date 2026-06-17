const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

let pets = [
  { id: 1, name: 'doggie', category: { id: 1, name: 'Dogs' }, photoUrls: ['https://example.com/dog.jpg'], tags: [{ id: 1, name: 'friendly' }], status: 'available', age: 24 },
  { id: 2, name: 'kitty', category: { id: 2, name: 'Cats' }, photoUrls: ['https://example.com/cat.jpg'], tags: [{ id: 2, name: 'cute' }], status: 'available', age: 12 },
  { id: 3, name: 'bunny', category: { id: 3, name: 'Rabbits' }, photoUrls: ['https://example.com/bunny.jpg'], tags: [], status: 'pending', age: 6 }
];

let orders = [
  { id: 1, petId: 1, quantity: 1, shipDate: '2024-01-15T10:30:00Z', status: 'placed', complete: false },
  { id: 2, petId: 2, quantity: 2, shipDate: '2024-01-20T15:00:00Z', status: 'approved', complete: true }
];

let users = [
  { id: 1, username: 'john_doe', firstName: 'John', lastName: 'Doe', email: 'john@example.com', password: 'securePass123', phone: '+1-555-123-4567' },
  { id: 2, username: 'jane_smith', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com', password: 'passWord456', phone: '+1-555-987-6543' }
];

let nextPetId = 4;
let nextOrderId = 3;
let nextUserId = 3;

const ADMIN_TOKEN = 'admin-token-12345';

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ code: 401, message: 'Unauthorized', details: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.slice(7);
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ code: 401, message: 'Unauthorized', details: 'Invalid token' });
  }
  next();
}

function validatePet(pet) {
  if (!pet.name || typeof pet.name !== 'string' || pet.name.length === 0) {
    return 'Pet name is required and must be a non-empty string';
  }
  if (!pet.photoUrls || !Array.isArray(pet.photoUrls) || pet.photoUrls.length === 0) {
    return 'At least one photo URL is required';
  }
  if (pet.status && !['available', 'pending', 'sold'].includes(pet.status)) {
    return 'Status must be one of: available, pending, sold';
  }
  if (pet.age !== undefined && (typeof pet.age !== 'number' || pet.age < 0 || pet.age > 360)) {
    return 'Age must be a number between 0 and 360';
  }
  return null;
}

function validateOrder(order) {
  if (!order.petId || typeof order.petId !== 'number' || order.petId < 1) {
    return 'Valid petId is required';
  }
  if (!order.quantity || typeof order.quantity !== 'number' || order.quantity < 1 || order.quantity > 10) {
    return 'Quantity must be a number between 1 and 10';
  }
  if (order.status && !['placed', 'approved', 'delivered'].includes(order.status)) {
    return 'Status must be one of: placed, approved, delivered';
  }
  return null;
}

function validateUser(user) {
  if (!user.username || typeof user.username !== 'string' || user.username.length < 3 || user.username.length > 20) {
    return 'Username must be between 3 and 20 characters';
  }
  if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(user.username)) {
    return 'Username contains invalid characters';
  }
  if (!user.email || typeof user.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) {
    return 'Valid email is required';
  }
  if (!user.password || typeof user.password !== 'string' || user.password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  return null;
}

function getPets(req, res) {
  let result = [...pets];
  
  if (req.query.status) {
    if (!['available', 'pending', 'sold'].includes(req.query.status)) {
      return res.status(400).json({ code: 400, message: 'Invalid status value', details: 'Status must be one of: available, pending, sold' });
    }
    result = result.filter(p => p.status === req.query.status);
  }
  
  if (req.query.limit) {
    const limit = parseInt(req.query.limit);
    if (isNaN(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ code: 400, message: 'Invalid limit value', details: 'Limit must be between 1 and 100' });
    }
    result = result.slice(0, limit);
  }
  
  res.json(result);
}

function addPet(req, res) {
  const validationError = validatePet(req.body);
  if (validationError) {
    return res.status(400).json({ code: 400, message: 'Invalid input', details: validationError });
  }
  
  const newPet = {
    id: nextPetId++,
    name: req.body.name,
    category: req.body.category || null,
    photoUrls: req.body.photoUrls,
    tags: req.body.tags || [],
    status: req.body.status || 'available',
    age: req.body.age || 0
  };
  
  pets.push(newPet);
  res.status(201).json(newPet);
}

function getPetById(req, res) {
  const petId = parseInt(req.params.petId);
  if (isNaN(petId) || petId < 1) {
    return res.status(400).json({ code: 400, message: 'Invalid ID supplied', details: 'Pet ID must be a positive integer' });
  }
  
  const pet = pets.find(p => p.id === petId);
  if (!pet) {
    return res.status(404).json({ code: 404, message: 'Pet not found', details: `No pet with ID ${petId}` });
  }
  
  res.json(pet);
}

function updatePet(req, res) {
  const petId = parseInt(req.params.petId);
  if (isNaN(petId) || petId < 1) {
    return res.status(400).json({ code: 400, message: 'Invalid ID supplied', details: 'Pet ID must be a positive integer' });
  }
  
  const petIndex = pets.findIndex(p => p.id === petId);
  if (petIndex === -1) {
    return res.status(404).json({ code: 404, message: 'Pet not found', details: `No pet with ID ${petId}` });
  }
  
  const validationError = validatePet(req.body);
  if (validationError) {
    return res.status(400).json({ code: 400, message: 'Invalid input', details: validationError });
  }
  
  pets[petIndex] = {
    ...pets[petIndex],
    ...req.body,
    id: petId
  };
  
  res.json(pets[petIndex]);
}

function deletePet(req, res) {
  const petId = parseInt(req.params.petId);
  if (isNaN(petId) || petId < 1) {
    return res.status(400).json({ code: 400, message: 'Invalid ID supplied', details: 'Pet ID must be a positive integer' });
  }
  
  const petIndex = pets.findIndex(p => p.id === petId);
  if (petIndex === -1) {
    return res.status(404).json({ code: 404, message: 'Pet not found', details: `No pet with ID ${petId}` });
  }
  
  pets.splice(petIndex, 1);
  res.status(204).send();
}

function uploadImage(req, res) {
  const petId = parseInt(req.params.petId);
  if (isNaN(petId) || petId < 1) {
    return res.status(400).json({ code: 400, message: 'Invalid ID supplied', details: 'Pet ID must be a positive integer' });
  }
  
  const pet = pets.find(p => p.id === petId);
  if (!pet) {
    return res.status(404).json({ code: 404, message: 'Pet not found', details: `No pet with ID ${petId}` });
  }
  
  res.json({ code: 200, type: 'success', message: 'Image uploaded successfully' });
}

function listOrders(req, res) {
  res.json(orders);
}

function placeOrder(req, res) {
  const validationError = validateOrder(req.body);
  if (validationError) {
    return res.status(400).json({ code: 400, message: 'Invalid order', details: validationError });
  }
  
  const petExists = pets.some(p => p.id === req.body.petId);
  if (!petExists) {
    return res.status(400).json({ code: 400, message: 'Invalid order', details: `Pet with ID ${req.body.petId} does not exist` });
  }
  
  const newOrder = {
    id: nextOrderId++,
    petId: req.body.petId,
    quantity: req.body.quantity,
    shipDate: req.body.shipDate || new Date().toISOString(),
    status: req.body.status || 'placed',
    complete: req.body.complete || false
  };
  
  orders.push(newOrder);
  res.status(201).json(newOrder);
}

function getOrderById(req, res) {
  const orderId = parseInt(req.params.orderId);
  if (isNaN(orderId) || orderId < 1 || orderId > 100) {
    return res.status(400).json({ code: 400, message: 'Invalid ID supplied', details: 'Order ID must be between 1 and 100' });
  }
  
  const order = orders.find(o => o.id === orderId);
  if (!order) {
    return res.status(404).json({ code: 404, message: 'Order not found', details: `No order with ID ${orderId}` });
  }
  
  res.json(order);
}

function deleteOrder(req, res) {
  const orderId = parseInt(req.params.orderId);
  if (isNaN(orderId) || orderId < 1) {
    return res.status(400).json({ code: 400, message: 'Invalid ID supplied', details: 'Order ID must be a positive integer' });
  }
  
  const orderIndex = orders.findIndex(o => o.id === orderId);
  if (orderIndex === -1) {
    return res.status(404).json({ code: 404, message: 'Order not found', details: `No order with ID ${orderId}` });
  }
  
  orders.splice(orderIndex, 1);
  res.status(204).send();
}

function createUser(req, res) {
  const validationError = validateUser(req.body);
  if (validationError) {
    return res.status(400).json({ code: 400, message: 'Invalid user data', details: validationError });
  }
  
  const existingUser = users.find(u => u.username === req.body.username || u.email === req.body.email);
  if (existingUser) {
    return res.status(400).json({ code: 400, message: 'Invalid user data', details: 'Username or email already exists' });
  }
  
  const newUser = {
    id: nextUserId++,
    username: req.body.username,
    firstName: req.body.firstName || '',
    lastName: req.body.lastName || '',
    email: req.body.email,
    password: req.body.password,
    phone: req.body.phone || ''
  };
  
  users.push(newUser);
  res.status(201).json(newUser);
}

function getUserByName(req, res) {
  const username = req.params.username;
  if (!username || username.length < 3 || username.length > 20 || !/^[a-zA-Z0-9_.-]{3,20}$/.test(username)) {
    return res.status(400).json({ code: 400, message: 'Invalid username supplied', details: 'Username must be 3-20 characters and contain only letters, numbers, underscores, dots, or hyphens' });
  }
  
  const user = users.find(u => u.username === username);
  if (!user) {
    return res.status(404).json({ code: 404, message: 'User not found', details: `No user with username ${username}` });
  }
  
  res.json(user);
}

app.get('/pets', getPets);
app.post('/pets', addPet);
app.get('/pets/:petId', getPetById);
app.put('/pets/:petId', updatePet);
app.delete('/pets/:petId', deletePet);
app.post('/pets/:petId/uploadImage', uploadImage);
app.get('/orders', listOrders);
app.post('/orders', placeOrder);
app.get('/orders/:orderId', getOrderById);
app.delete('/orders/:orderId', deleteOrder);
app.post('/users', createUser);
app.get('/users/:username', getUserByName);

app.get('/admin/stats', requireAuth, (req, res) => {
  res.json({
    totalPets: pets.length,
    totalOrders: orders.length,
    totalUsers: users.length,
    nextPetId,
    nextOrderId,
    nextUserId,
    uptime: process.uptime()
  });
});

app.head('/admin/stats', requireAuth, (req, res) => {
  res.status(200).send();
});

app.all('*', (req, res) => {
  res.status(404).json({ code: 404, message: 'Not found', details: `Endpoint ${req.method} ${req.path} not found` });
});

app.listen(PORT, () => {
  console.log(`Pet Store Mock Server is running on http://localhost:${PORT}`);
  console.log(`Available endpoints:`);
  console.log(`  GET    /pets`);
  console.log(`  POST   /pets`);
  console.log(`  GET    /pets/:petId`);
  console.log(`  PUT    /pets/:petId`);
  console.log(`  DELETE /pets/:petId`);
  console.log(`  POST   /pets/:petId/uploadImage`);
  console.log(`  GET    /orders`);
  console.log(`  POST   /orders`);
  console.log(`  GET    /orders/:orderId`);
  console.log(`  DELETE /orders/:orderId`);
  console.log(`  POST   /users`);
  console.log(`  GET    /users/:username`);
  console.log(`  GET    /admin/stats (requires Bearer token)`);
  console.log(`  HEAD   /admin/stats (requires Bearer token)`);
});
