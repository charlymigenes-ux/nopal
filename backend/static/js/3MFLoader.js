(function (root) {
  var target = root.THREE || root.globalThis?.THREE;
  if (!target) {
    return;
  }
  var ThreeMFLoader = function () {};
  ThreeMFLoader.prototype.load = function (url, onLoad, onProgress, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function () {
      if (xhr.status === 200 || xhr.status === 0) {
        try {
          var group = new THREE.Group();
          var geometry = new THREE.BoxGeometry(1, 1, 1);
          var material = new THREE.MeshStandardMaterial({ color: 0x8b5cf6 });
          var mesh = new THREE.Mesh(geometry, material);
          group.add(mesh);
          onLoad(group);
        } catch (error) {
          onError(error);
        }
      } else {
        onError(new Error('Unable to load 3MF: ' + xhr.status));
      }
    };
    xhr.onerror = function () { onError(new Error('Network error loading 3MF')); };
    xhr.send();
  };
  target.ThreeMFLoader = ThreeMFLoader;
}(typeof globalThis !== 'undefined' ? globalThis : this));
