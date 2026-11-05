async function start() {
  if (!navigator.gpu) {
    fail('WebGPU not supported.');
    return;
  }

  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    fail('Couldn’t request WebGPU adapter.');
    return;
  }

  const device = await adapter.requestDevice();

  if (!device) {
    fail('need a browser that supports WebGPU');
    return;
  }

  // if we intentionally destroy the device, reason will be 'detroyed'
  device.lost.then((info) => {
    if (info.reason !== 'destroyed') {
      //try again
      start();
    }
  });
  main(device);
}

function main(device: GPUDevice) {
  console.log('Happy developing ✨');
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  const context = canvas.getContext('webgpu') as GPUCanvasContext;

  const devicePixelRatio = window.devicePixelRatio;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();

  context.configure({
    device,
    format: presentationFormat,
  });

  const module = device.createShaderModule({
    label: 'triangle shaders with uniforms',
    code: /* wgsl */ `
      struct Vertex {
        @location(0) position: vec2f,
        @location(1) color: vec4f,
        @location(2) offset: vec2f,
        @location(3) scale: vec2f,
        @location(4) perVertexColor: vec3f,
      };
      
      struct VSOutput {
        @builtin(position) position: vec4f,
        @location(0) color: vec4f,
      };
      
     
      @vertex fn vs(
        vert: Vertex,
      ) -> VSOutput {
        
        var vsOut: VSOutput;
        vsOut.position = 
            vec4f(vert.position * vert.scale + vert.offset, 0.0, 1.0);
        vsOut.color = vert.color * vec4f(vert.perVertexColor, 1);
        
        return vsOut;
      }
      
       @fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
        return vsOut.color;
      }
    `,
  });

  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: module,
      buffers: [
        {
          arrayStride: 5 * 4, // 5 floats, 4 bytes each,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
            { shaderLocation: 4, offset: 8, format: 'float32x3' }, // perVertexColor
          ],
        },
        {
          arrayStride: 6 * 4,
          stepMode: 'instance',
          attributes: [
            {
              shaderLocation: 1,
              offset: 0,
              format: 'float32x4',
            }, // color
            { shaderLocation: 2, offset: 16, format: 'float32x2' }, // offset
          ],
        },
        {
          arrayStride: 2 * 4, // 2 floats, 4 bytes each
          stepMode: 'instance',
          attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x2' }], // scale
        },
      ],
    },
    fragment: {
      module: module,
      targets: [
        {
          format: presentationFormat,
        },
      ],
    },
    primitive: {
      topology: 'triangle-list',
    },
  });

  // Memory layout stuff
  const kNumbObjects = 100;
  const objectInfos: Array<{
    scale: number;
    // uniformBuffer: GPUBuffer;
    // uniformValues: Float32Array<ArrayBuffer>;
    // bindGroup: GPUBindGroup;
  }> = [];

  // create 2 vertex buffers
  const staticUnitSize = 4 * 4 + 2 * 4; // color, scale (no padding needed on vertex shaders)
  const changingUnitSize = 2 * 4; // scale
  const staticVertexBufferSize = staticUnitSize * kNumbObjects;
  const changingVertexBufferSize = changingUnitSize * kNumbObjects;

  const staticVertexBuffer = device.createBuffer({
    label: 'static vertex for objects',
    size: staticVertexBufferSize,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const changingVertexBuffer = device.createBuffer({
    label: 'changing vertex for objects',
    size: changingVertexBufferSize,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });

  const kColorOffset = 0;
  const kOffsetOffset = 4;

  const kScaleOffset = 0;

  {
    const staticStorageValues = new Float32Array(staticVertexBufferSize / 4);
    for (let i = 0; i < kNumbObjects; i++) {
      const staticOffset = i * (staticUnitSize / 4);

      // These are only set once now
      staticStorageValues.set(
        [rand(), rand(), rand(), 1],
        staticOffset + kColorOffset,
      );
      staticStorageValues.set(
        [rand(-0.9, 0.9), rand(-0.9, 0.9)],
        staticOffset + kOffsetOffset,
      );

      objectInfos.push({ scale: rand(0.2, 0.5) });

      device.queue.writeBuffer(staticVertexBuffer, 0, staticStorageValues);
    }
  }

  // circle buffer
  const { vertexData, numVertices } = createCircleVertices({
    radius: 0.5,
    innerRadius: 0.25,
  });

  const vertexBuffer = device.createBuffer({
    label: 'vertex buffer vertices',
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertexData);

  // a typed array we can use to update the changingStorageBuffer
  const storageValues = new Float32Array(changingVertexBufferSize / 4);

  const renderPassDescriptor: GPURenderPassDescriptor = {
    label: 'renderPassDescriptor',
    colorAttachments: [
      {
        view: {} as GPUTextureView,
        clearValue: [0.3, 0.3, 0.3, 1],
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  };

  // Main looping fn
  function render() {
    // Get the current texture from the canvas context and
    // set it as the texture to render to.
    renderPassDescriptor.colorAttachments[0]!.view = context
      .getCurrentTexture()
      .createView();

    // make a command encoder to start encoding commands
    const encoder = device.createCommandEncoder({ label: 'our encoder' }); // make a render pass encoder to encode render specific commands
    const pass = encoder.beginRenderPass(
      renderPassDescriptor as GPURenderPassDescriptor,
    );
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setVertexBuffer(1, staticVertexBuffer);
    pass.setVertexBuffer(2, changingVertexBuffer);

    // set uniform values in our JS side F32 Array
    const aspect = canvas.width / canvas.height;

    objectInfos.forEach(({ scale }, index) => {
      const offset = index * (changingUnitSize / 4);
      storageValues.set([scale / aspect, scale], offset + kScaleOffset);
    });
    device.queue.writeBuffer(changingVertexBuffer, 0, storageValues);

    pass.draw(numVertices, kNumbObjects); // call our vertex shader 3 times for each instance
    pass.end();

    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);
  }

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const canvas = entry.target as HTMLCanvasElement;
      const width = entry.contentBoxSize[0].inlineSize;
      const height = entry.contentBoxSize[0].blockSize;
      canvas.width = Math.max(
        1,
        Math.min(width, device.limits.maxTextureDimension2D),
      );
      canvas.height = Math.max(
        1,
        Math.min(height, device.limits.maxTextureDimension2D),
      );

      render();
    }
  });
  observer.observe(canvas);
  //await computation(device);
}
function fail(msg: any) {
  // eslint-disable-next-line no-alert
  alert(msg);
}

async function computation(device: GPUDevice) {
  const module = device.createShaderModule({
    label: 'doubling compute module',
    code: /* wgsl */ `
      @group(0) @binding(0) var<storage, read_write> data: array<f32>;
      
      @compute @workgroup_size(1) fn computeSomething(
        @builtin(global_invocation_id) id: vec3u
      ) {
        let i = id.x;
        data[i] = data[i] * 2.0;
      }
    `,
  });

  const pipeline = device.createComputePipeline({
    label: 'doubling compute pipeline',
    layout: 'auto',
    compute: {
      module,
    },
  });

  const input = new Float32Array([1, 3, 5]);
  // create buffer on the GPU to hold our computation
  const workBuffer = device.createBuffer({
    label: 'work buffer',
    size: input.byteLength,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_SRC |
      GPUBufferUsage.COPY_DST,
  });
  // Copy our input data to that buffer
  device.queue.writeBuffer(workBuffer, 0, input);

  // create a buffer on the GPU to get a copy of the results
  const resultBuffer = device.createBuffer({
    label: 'result buffer',
    size: input.byteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // Setup a bindGroup to tell the shader which
  // buffer to use for the computation
  const bindGroup = device.createBindGroup({
    label: 'bindGroup for work buffer',
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: workBuffer }],
  });

  // Encode commands to do the computation
  const encoder = device.createCommandEncoder({
    label: 'doubling encoder',
  });
  const pass = encoder.beginComputePass({
    label: 'doubling compute pass',
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(input.length);
  pass.end();

  // Encode a command to copy the results to a mappable buffer.
  encoder.copyBufferToBuffer(workBuffer, 0, resultBuffer, 0, resultBuffer.size);

  // Finish encoding and submit the commands
  const commandBuffer = encoder.finish();
  device.queue.submit([commandBuffer]);

  // Read the results
  await resultBuffer.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(resultBuffer.getMappedRange());

  console.log('input', input);
  console.log('result', result);

  resultBuffer.unmap();

  //...
}

const rand = (min?: number, max?: number) => {
  if (min === undefined) {
    min = 0;
    max = 1;
  } else if (max === undefined) {
    max = min;
    min = 0;
  }
  return min + Math.random() * (max - min);
};

// Donut-like circle
function createCircleVertices({
  radius = 1,
  numSubdivisions = 24,
  innerRadius = 0,
  startAngle = 0,
  endAngle = Math.PI * 2,
} = {}) {
  // 2 triangles per subdivision, 3 verts per tri, 2 values (xy) each
  const numVertices = numSubdivisions * 3 * 2;
  const vertexData = new Float32Array(numVertices * (2 + 3));

  let offset = 0;

  const addVertex = (x: number, y: number, ...rest: number[]) => {
    const [r, g, b] = rest;
    vertexData[offset++] = x;
    vertexData[offset++] = y;
    vertexData[offset++] = r;
    vertexData[offset++] = g;
    vertexData[offset++] = b;
  };
  // 2 triangles per subdivision
  //
  // 0--1 4
  // | / /|
  // |/ / |
  // 2 3--5

  const innerColor = [1, 1, 1];
  const outerColor = [0.1, 0.1, 0.1];

  for (let i = 0; i < numSubdivisions; i++) {
    const angle1 =
      startAngle + ((i + 0) * (endAngle - startAngle)) / numSubdivisions;
    const angle2 =
      startAngle + ((i + 1) * (endAngle - startAngle)) / numSubdivisions;

    const c1 = Math.cos(angle1);
    const s1 = Math.sin(angle1);
    const c2 = Math.cos(angle2);
    const s2 = Math.sin(angle2);

    // first triangle
    //@ts-ignore
    addVertex(c1 * radius, s1 * radius, ...outerColor);
    //@ts-ignore
    addVertex(c2 * radius, s2 * radius, ...outerColor);
    //@ts-ignore
    addVertex(c1 * innerRadius, s1 * innerRadius, ...innerColor);

    // second triangle
    addVertex(c1 * innerRadius, s1 * innerRadius, ...innerColor);
    addVertex(c2 * radius, s2 * radius, ...outerColor);
    addVertex(c2 * innerRadius, s2 * innerRadius, ...innerColor);
  }

  return {
    vertexData,
    numVertices,
  };
}

start();
