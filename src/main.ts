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
    code: /* language=WGSL */ `      
      struct VSOutput {
        @builtin(position) position: vec4f,
        @location(0) texcoord: vec2f,
      };
      
     
      @vertex fn vs(
        @builtin(vertex_index) vertexIndex: u32,
      ) -> VSOutput {
        let pos = array(
          //1st triangle
          vec2f( 0.0, 0.0 ), // center
          vec2f( 1.0, 0.0 ), // right, center
          vec2f( 0.0, 1.0 ), // center, top
          
          // 2nd triangle
          vec2f( 0.0, 1.0 ), // center, top
          vec2f( 1.0, 0.0 ), // right, center
          vec2f( 1.0, 1.0 ), // right, top
        );
        var vsOutput: VSOutput;
        let xy = pos[vertexIndex];
        vsOutput.position = vec4f(xy, 0.0, 1.0);
        vsOutput.texcoord = vec2f(xy.x, 1.0 - xy.y);
        return vsOutput;
      }
      
      @group(0) @binding(0) var ourSampler: sampler;
      @group(0) @binding(1) var ourTexture: texture_2d<f32>;
      
       @fragment fn fs(fsInput: VSOutput) -> @location(0) vec4f {
        return textureSample(ourTexture, ourSampler, fsInput.texcoord);
      }
    `,
  });

  const pipeline = device.createRenderPipeline({
    label: 'hardcoded textured quad pipeline',
    layout: 'auto',
    vertex: {
      module,
    },
    fragment: {
      module,
      targets: [{ format: presentationFormat }],
    },
  });

  // Texture data
  const kTextureWidth = 5;
  const kTextureHeight = 7;
  const _ = [255, 0, 0, 255]; //red
  const y = [255, 255, 0, 255]; //yellow
  const b = [0, 0, 255, 255]; //red
  // prettier-multiline-arrays-next-line-pattern: 5 5
  const textureData = new Uint8Array(
    [
      b, _, _, _, _,
      _, y, y, y, _,
      _, y, _, _, _,
      _, y, y, _, _,
      _, y, _, _, _,
      _, y, _, _, _,
      _, _, _, _, _,
    ].flat(),
  );

  const texture = device.createTexture({
    size: [kTextureWidth, kTextureHeight],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  device.queue.writeTexture(
    { texture },
    textureData,
    { bytesPerRow: kTextureWidth * 4 },
    { width: kTextureWidth, height: kTextureHeight },
  );

  const sampler = device.createSampler();

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: texture },
    ],
  });

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
    pass.setBindGroup(0, bindGroup);

    pass.draw(6);
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
  // 2 triangles at each subdivision, + 1 to wrap around the circle
  const numVertices = (numSubdivisions + 1) * 2;

  // 2 32-bit (4byte) values and 1 32-bit value for color (rgb_)
  // The 32-bit color value will be written/read as 4 8-bit values
  const vertexData = new Float32Array(numVertices * (2 + 1));
  const colorData = new Uint8Array(vertexData.buffer);

  let offset = 0;
  let colorOffset = 8;

  const addVertex = (x: number, y: number, ...rest: number[]) => {
    const [r, g, b] = rest;
    vertexData[offset++] = x;
    vertexData[offset++] = y;

    offset += 1; // skip the color
    colorData[colorOffset++] = r * 255;
    colorData[colorOffset++] = g * 255;
    colorData[colorOffset++] = b * 255;
    colorOffset += 9; // skip extra byte and the position
  };

  // press on with index buffers

  // 2 triangles per subdivision
  //
  // 0 2 4 6 8 ...
  //
  // 1 3 5 7 9 ...

  const innerColor = [1, 1, 1];
  const outerColor = [0.1, 0.1, 0.1];

  for (let i = 0; i <= numSubdivisions; i++) {
    const angle1 =
      startAngle + ((i + 0) * (endAngle - startAngle)) / numSubdivisions;

    const c1 = Math.cos(angle1);
    const s1 = Math.sin(angle1);

    // first triangle
    addVertex(c1 * radius, s1 * radius, ...outerColor);
    addVertex(c1 * innerRadius, s1 * innerRadius, ...innerColor);
  }

  // 1st tri  2nd tri  3rd tri  4th tri
  // 0 1 2    2 1 3    2 3 4    4 3 5
  //
  // 0--2        2     2--4        4  .....
  // | /        /|     | /        /|
  // |/        / |     |/        / |
  // 1        1--3     3        3--5  .....
  const indexData = new Uint16Array(numSubdivisions * 6);
  let ndx = 0;
  for (let i = 0; i < numSubdivisions; ++i) {
    const ndxOffset = i * 2;

    // first triangle
    indexData[ndx++] = ndxOffset;
    indexData[ndx++] = ndxOffset + 1;
    indexData[ndx++] = ndxOffset + 2;

    // second triangle
    indexData[ndx++] = ndxOffset + 2;
    indexData[ndx++] = ndxOffset + 1;
    indexData[ndx++] = ndxOffset + 3;
  }

  return {
    vertexData,
    indexData,
    numVertices: indexData.length,
  };
}

start();
