// Инициализация Telegram (если открыто внутри Telegram)
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

// Читаем сессию из localStorage (та же запись, что и в index.html)
let authToken = null;
let currentUser = null;
try {
  const stored = localStorage.getItem('tver_user');
  if (stored) {
    currentUser = JSON.parse(stored);
    authToken = currentUser.token || null;
  }
} catch (e) {
  authToken = null;
  currentUser = null;
}

function authHeaders() {
  const headers = {};
  if (authToken) {
    headers['Authorization'] = 'Bearer ' + authToken;
  }
  return headers;
}

// Инициализация карты
const map = L.map('map', {
    center: [56.8587, 35.9176],
    zoom: 14,
    zoomControl: false
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 20
}).addTo(map);

// Глобальные переменные
let userPosition = null;
let userMarker = null;
let allBenches = [];

// Загрузка скамеек
async function loadBenches() {
    try {
        const response = await fetch('/api/benches');
        const data = await response.json();
        allBenches = data.benches;
        displayBenches();
        updateStats();
        showToast('✅ Загружено скамеек: ' + allBenches.length);
    } catch (error) {
        showToast('❌ Ошибка загрузки');
    }
}

// Отображение скамеек
function displayBenches() {
    map.eachLayer((layer) => {
        if (layer instanceof L.Marker && layer !== userMarker) {
            map.removeLayer(layer);
        }
    });

    allBenches.forEach(bench => {
        const marker = L.marker([bench.latitude, bench.longitude], {
            icon: L.divIcon({
                className: 'bench-marker',
                html: '🪑',
                iconSize: [35, 35],
                iconAnchor: [17, 35]
            })
        }).addTo(map);

        marker.bindPopup(`
            <b>${bench.name}</b><br>
            ${bench.description || ''}<br>
            <small>Добавил: ${bench.user_name || 'Аноним'}</small>
        `);
    });
}

// Получение геолокации
function getLocation() {
    if (navigator.geolocation) {
        document.getElementById('locationStatus').textContent = '⏳ Определение...';
        
        navigator.geolocation.getCurrentPosition(
            (position) => {
                userPosition = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };
                
                document.getElementById('locationStatus').textContent = 
                    '✅ ' + userPosition.lat.toFixed(5) + ', ' + userPosition.lng.toFixed(5);
                
                updateUserMarker();
            },
            (error) => {
                document.getElementById('locationStatus').textContent = '❌ Ошибка геолокации';
            }
        );
    }
}

// Обновление маркера пользователя
function updateUserMarker() {
    if (userMarker) {
        map.removeLayer(userMarker);
    }
    
    if (userPosition) {
        userMarker = L.marker([userPosition.lat, userPosition.lng], {
            icon: L.divIcon({
                className: '',
                html: '<div style="width: 15px; height: 15px; background: #3498db; border: 3px solid white; border-radius: 50%;"></div>',
                iconSize: [15, 15],
                iconAnchor: [7, 7]
            })
        }).addTo(map);
        
        map.setView([userPosition.lat, userPosition.lng], 16);
    }
}

// Центрирование на пользователе
function centerOnUser() {
    if (userPosition) {
        map.setView([userPosition.lat, userPosition.lng], 17);
    } else {
        getLocation();
    }
}

// Открытие модального окна
function openAddModal() {
    document.getElementById('addModal').classList.add('active');
    getLocation();
}

// Сохранение скамейки
async function saveBench() {
    if (!authToken) {
        showToast('⚠️ Требуется авторизация. Войдите через главную страницу.');
        return;
    }

    const name = document.getElementById('benchName').value;
    const description = document.getElementById('benchDescription').value;
    const photoFiles = document.getElementById('photoInput').files;
    
    if (!name) {
        showToast('⚠️ Введите название');
        return;
    }
    
    if (!userPosition) {
        showToast('⚠️ Определите геолокацию');
        return;
    }
    
    const formData = new FormData();
    formData.append('name', name);
    formData.append('description', description);
    formData.append('latitude', userPosition.lat);
    formData.append('longitude', userPosition.lng);
    
    for (let i = 0; i < photoFiles.length; i++) {
        formData.append('photos', photoFiles[i]);
    }
    
    try {
        const response = await fetch('/api/benches', {
            method: 'POST',
            headers: authHeaders(),
            body: formData
        });
        
        if (response.ok) {
            document.getElementById('addModal').classList.remove('active');
            document.getElementById('benchName').value = '';
            document.getElementById('benchDescription').value = '';
            document.getElementById('photoInput').value = '';
            
            if (tg) {
              tg.sendData(JSON.stringify({
                  action: 'bench_added',
                  bench_name: name
              }));
            }
            
            loadBenches();
            showToast('✅ Скамейка добавлена!');
        } else {
            const data = await response.json();
            showToast(data.error || '❌ Ошибка сохранения');
        }
    } catch (error) {
        showToast('❌ Ошибка сохранения');
    }
}

// Обновление статистики
async function updateStats() {
    try {
        const response = await fetch('/api/stats');
        const stats = await response.json();
        document.getElementById('statsBadge').textContent = 
            '🪑 ' + stats.total_benches + ' | 👥 ' + stats.total_users;
    } catch (error) {
        console.error('Error:', error);
    }
}

// Toast уведомления
function showToast(message) {
    const existingToast = document.querySelector('.toast');
    if (existingToast) existingToast.remove();
    
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.remove(), 3000);
}

// Кнопка назад
if (tg) {
  tg.BackButton.onClick(() => {
    document.getElementById('addModal').classList.remove('active');
  });
}

// Загрузка при старте
loadBenches();
getLocation();
