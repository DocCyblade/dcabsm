# A Host for the container layer (spec 13.2): systemd as PID 1 on one supported OS, privileged when run.
# Build:  docker build --build-arg BASE=debian:13 -t dcabsm-test:debian-13 test/container
# Nothing of DCABSM or Nginx is in the image. The journey installs them the way a System Admin would.
ARG BASE=debian:13
FROM ${BASE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus ca-certificates curl gpgv gnupg openssl xz-utils tar sudo \
      iproute2 procps util-linux less \
 && rm -rf /var/lib/apt/lists/*

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
