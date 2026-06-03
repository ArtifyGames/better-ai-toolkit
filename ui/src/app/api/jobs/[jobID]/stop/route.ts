import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET(request: NextRequest, { params }: { params: Promise<{ jobID: string }> }) {
  const { jobID } = await params;

  const job = await prisma.job.findUnique({
    where: { id: jobID },
  });

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  const updatedJob = await prisma.job.update({
    where: { id: jobID },
    data: {
      stop: true,
      info: 'Stopping job after saving current step...',
    },
  });

  console.log(`Job ${jobID} marked to stop after saving the current step`);

  return NextResponse.json(updatedJob);
}
