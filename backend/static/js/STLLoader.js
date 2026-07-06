(function (root) {
  var target = root.THREE || root.globalThis?.THREE;
  if (!target) {
    return;
  }
  var STLLoader = function () {};
  STLLoader.prototype.load = function (url, onLoad, onProgress, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function () {
      if (xhr.status === 200 || xhr.status === 0) {
        try {
          var geometry = new THREE.BufferGeometry();
          var view = new DataView(xhr.response);
          var header = new TextDecoder().decode(new Uint8Array(xhr.response.slice(0, 80)));
          var ascii = header.indexOf('solid') !== -1;

          if (ascii) {
            var text = new TextDecoder().decode(xhr.response);
            var lines = text.split(/\r?\n/);
            var vertices = [];
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();
              var parts = line.split(/\s+/);
              if (parts[0] === 'vertex' && parts.length >= 4) {
                vertices.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
              }
            }
            if (vertices.length) {
              geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
              geometry.computeVertexNormals();
              onLoad(geometry);
              return;
            }
          }

          if (view.getUint32(80, true) === 0) {
            onError(new Error('Unsupported STL format'));
            return;
          }

          var faceCount = view.getUint32(80, true);
          var offset = 84;
          var positions = [];
          for (var i = 0; i < faceCount; i++) {
            offset += 12;
            positions.push(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
            offset += 12;
            positions.push(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
            offset += 12;
            positions.push(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
            offset += 12;
            offset += 2;
          }
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
          geometry.computeVertexNormals();
          onLoad(geometry);
        } catch (error) {
          onError(error);
        }
      } else {
        onError(new Error('Unable to load STL: ' + xhr.status));
      }
    };
    xhr.onerror = function () { onError(new Error('Network error loading STL')); };
    xhr.send();
  };
  target.STLLoader = STLLoader;
}(typeof globalThis !== 'undefined' ? globalThis : this));
