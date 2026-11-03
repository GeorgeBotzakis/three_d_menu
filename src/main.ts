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
      
      @group(0) @binding(0) var<uniform> ourStruct: OurStruct;
      @group(0) @binding(1) var<uniform> otherStruct: OtherStruct;
     
      @vertex fn vs(
        @builtin(vertex_index) vertexIndex : u32
      ) -> @builtin(position) vec4f {
        let pos = array(
          vec2f( 0.0,  0.5),  // top center
          vec2f(-0.5, -0.5),  // bottom left
          vec2f( 0.5, -0.5)   // bottom right
        );
        
        return vec4f(pos[vertexIndex] * otherStruct.scale + ourStruct.offset, 0.0, 1.0);
      }
      
       @fragment fn fs() -> @location(0) vec4f {
        return ourStruct.color;
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
  const staticUniformBufferSize = 4 * 4 + 2 * 4 + 2 * 4; // color, scale, padding
  const uniformBufferSize = 2 * 4; // scale

  const uniformBuffer = device.createBuffer({
    size: staticUniformBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const kColorOffset = 0;
  const kOffsetOffset = 4;

  const kScaleffset = 0;

  const kNumbObjects = 100;
  const objectInfos: Array<{
    scale: number;
    uniformBuffer: GPUBuffer;
    uniformValues: Float32Array<ArrayBuffer>;
    bindGroup: GPUBindGroup;
  }> = [];
  for (let i = 0; i < kNumbObjects; i++) {
    const staticUniformBuffer = device.createBuffer({
      label: `static uniforms for obj: ${i}`,
      size: staticUniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    {
      // create a typedarray to hold the value for the uniforms in JS
      const uniformValues = new Float32Array(staticUniformBufferSize / 4);
      uniformValues.set([rand(), rand(), rand(), 1], kColorOffset);
      uniformValues.set([rand(-0.9, 0.9), rand(-0.9, 0.9)], kOffsetOffset);

      device.queue.writeBuffer(staticUniformBuffer, 0, uniformValues);
    }

    const uniformValues = new Float32Array(uniformBufferSize / 4);
    const uniformBuffer = device.createBuffer({
      label: `changing uniforms for obj: ${i}`,
      size: uniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroup = device.createBindGroup({
      label: `bind group for obj: ${i}`,
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: staticUniformBuffer },
        { binding: 1, resource: uniformBuffer },
      ],
    });

    objectInfos.push({
      scale: rand(0.2, 0.5),
      uniformBuffer,
      uniformValues,
      bindGroup,
    });
  }

  let value = 1;
  let lasttime = 0;
  const gameloop: FrameRequestCallback = (timestamp) => {
    const delta = timestamp - lasttime / 1000;
    value = Math.sin(delta) / 2.0 + 0.5;
    console.log(value);
    // window.requestAnimationFrame(gameloop);
  };

  //  let time = window.requestAnimationFrame(gameloop);
  let colorValue;

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

    for (const {
      scale,
      bindGroup,
      uniformBuffer,
      uniformValues,
    } of objectInfos) {
      uniformValues.set([scale / aspect, scale], kScaleffset);
      device.queue.writeBuffer(uniformBuffer, 0, uniformValues);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3); // call our vertex shader 3 times
    }
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
