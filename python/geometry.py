"""Small geometry helpers shared by the exporters."""
import numpy as np


def rotate(xy, angle_deg):
    """Rotate an (N, 2) array of points by `angle_deg` degrees.

    The circuit info gives a recommended rotation per circuit so the map looks the
    way it does on TV. `xy @ matrix` is a matrix multiplication: every row (x, y)
    is turned into (x*cos - y*sin, x*sin + y*cos).
    """
    a = np.radians(angle_deg)
    rot = np.array([[np.cos(a), np.sin(a)],
                    [-np.sin(a), np.cos(a)]])
    return xy @ rot


class TrackPath:
    """A closed polyline (the outline of the track) on which we measure progress.

    progress(x, y) answers "how many data units from the start of the outline is the closest
    point of the path to (x, y)?". For every point we find the closest of the many short segments
    of the path and add the distance travelled inside that segment ("projection").
    """

    def __init__(self, xy):
        points = np.vstack([xy, xy[:1]])                  # close the loop
        self.points = points
        self.start = points[:-1]
        self.step = points[1:] - points[:-1]              # vector of every segment
        self.length_of = np.hypot(self.step[:, 0], self.step[:, 1])
        self.length_sq = np.maximum(self.length_of ** 2, 1e-9)
        self.before = np.concatenate([[0.0], np.cumsum(self.length_of)[:-1]])  # distance at segment start
        self.length = float(self.length_of.sum())          # length of the whole lap

    def progress(self, x, y):
        return self.project(x, y)[0]

    def project(self, x, y, near=None, reach=10):
        """Returns two arrays: the progress of every point (see above) and its distance to the path
        (how far it is sideways from the line), both in data units.

        Normally every point is compared with every segment. If the caller already knows roughly
        where each point is, `near` = an array with a segment index per point, and only the segments
        from near - reach to near + reach are tried: much faster on a path with thousands of segments.
        """
        x = np.asarray(x, dtype=float)
        y = np.asarray(y, dtype=float)
        count = len(self.start)
        progress = np.empty(len(x))
        offset = np.empty(len(x))
        for first in range(0, len(x), 2000):               # in chunks to keep memory small
            px = x[first:first + 2000, None]
            py = y[first:first + 2000, None]
            if near is None:
                seg = np.arange(count)[None, :]            # every segment, for every point
            else:                                          # (points, 2 * reach + 1) segment indexes
                seg = (np.asarray(near[first:first + 2000])[:, None] + np.arange(-reach, reach + 1)) % count
            sx, sy = self.start[seg, 0], self.start[seg, 1]
            vx, vy = self.step[seg, 0], self.step[seg, 1]
            # Where on each segment is the closest point? 0 = its start, 1 = its end.
            along = np.clip(((px - sx) * vx + (py - sy) * vy) / self.length_sq[seg], 0.0, 1.0)
            dx = px - (sx + along * vx)
            dy = py - (sy + along * vy)
            squared = dx * dx + dy * dy
            best = np.argmin(squared, axis=1)              # closest segment for every point
            rows = np.arange(len(best))
            k = seg[rows, best] if near is not None else best
            progress[first:first + 2000] = self.before[k] + along[rows, best] * self.length_of[k]
            offset[first:first + 2000] = np.sqrt(squared[rows, best])
        return progress, offset

    def stretch(self, from_distance, to_distance):
        """The points of the path between two distances along it (the second one may be past
        the end of the lap: the path wraps around). Returns an (N, 2) array including both ends.
        """
        def point_at(distance):
            distance = distance % self.length
            k = min(int(np.searchsorted(self.before, distance, side="right")) - 1, len(self.start) - 1)
            f = (distance - self.before[k]) / self.length_of[k]
            return self.start[k] + f * self.step[k]

        # Corners of the outline that lie strictly between the two distances (each lap repeated
        # twice so that a stretch crossing the start of the outline also works).
        vertices = []
        for lap in (0, 1):
            for k in range(len(self.start)):
                d = self.before[k] + lap * self.length
                if from_distance < d < to_distance:
                    vertices.append(self.start[k])
        return np.array([point_at(from_distance)] + vertices + [point_at(to_distance)])
