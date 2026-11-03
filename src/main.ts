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
      struct OurStruct {
        color: vec4f,
        offset: vec2f,
      };
      struct OtherStruct {
        scale: vec2f,
      };
      struct VSOutput {
        @builtin(position) position: vec4f,
        @location(0) color: vec4f,
      }
      
      @group(0) @binding(0) var<storage, read> ourStructs: array<OurStruct>;
      @group(0) @binding(1) var<storage, read> otherStructs: array<OtherStruct>;
     
      @vertex fn vs(
        @builtin(vertex_index) vertexIndex : u32,
        @builtin(instance_index) instanceIndex: u32
      ) -> VSOutput {
        let pos = array(
          vec2f( 0.0,  0.5),  // top center
          vec2f(-0.5, -0.5),  // bottom left
          vec2f( 0.5, -0.5)   // bottom right
        );
        
        let otherStruct = otherStructs[instanceIndex];
        let ourStruct = ourStructs[instanceIndex];
        
        var vsOut: VSOutput;
        vsOut.position = 
            vec4f(pos[vertexIndex] * otherStruct.scale + ourStruct.offset, 0.0, 1.0);
        vsOut.color = ourStruct.color;
        
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

  const staticUnitSize = 4 * 4 + 2 * 4 + 2 * 4; // color, scale, padding
  const changingUnitSize = 2 * 4; // scale
  const staticStorageBufferSize = staticUnitSize * kNumbObjects;
  const changingStorageBufferSize = changingUnitSize * kNumbObjects;

  const staticStorageBuffer = device.createBuffer({
    label: 'static storage for objects',
    size: staticStorageBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const changingStorageBuffer = device.createBuffer({
    label: 'chaning storage for objects',
    size: changingStorageBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const kColorOffset = 0;
  const kOffsetOffset = 4;

  const kScaleOffset = 0;

  {
    const staticStorageValues = new Float32Array(staticStorageBufferSize / 4);
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

      device.queue.writeBuffer(staticStorageBuffer, 0, staticStorageValues);
    }
  }

  // a typed array we can use to update the changingStorageBuffer
  const storageValues = new Float32Array(changingStorageBufferSize / 4);

  const bindGroup = device.createBindGroup({
    label: `bind group for objects`,
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: staticStorageBuffer },
      { binding: 1, resource: changingStorageBuffer },
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

    // set uniform values in our JS side F32 Array
    const aspect = canvas.width / canvas.height;

    objectInfos.forEach(({ scale }, index) => {
      const offset = index * (changingUnitSize / 4);
      storageValues.set([scale / aspect, scale], offset + kScaleOffset);
    });
    device.queue.writeBuffer(changingStorageBuffer, 0, storageValues);

    pass.setBindGroup(0, bindGroup);
    pass.draw(3, kNumbObjects); // call our vertex shader 3 times for each instance
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

start();
